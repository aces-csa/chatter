package com.chatter.chat.domain;

import com.chatter.chat.api.ConversationMembership;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.platform.ratelimit.RateLimiter;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Voice and video calls, 1:1 and group, as a WebRTC mesh (every participant connected to every
 * other). Mesh is the only topology where media is end to end encrypted with no extra machinery:
 * each hop is a direct DTLS-SRTP connection between the two people. An SFU would scale further
 * but would sit in the media path, needing Insertable Streams / SFrame to keep E2EE. Mesh upload
 * cost grows with participants, hence the cap.
 *
 * <p>State is ephemeral, in Redis only: who is in the call, refreshed by a heartbeat. Nothing
 * about a call is written to the database, and signalling never touches Kafka -- a call cannot
 * wait for an outbox poll.
 */
@Service
public class CallService {

    public static final int MAX_PARTICIPANTS = 8;
    /** A participant who stops heart-beating is dropped after this. */
    private static final Duration STALE_AFTER = Duration.ofSeconds(45);
    private static final Duration KEY_TTL = Duration.ofMinutes(2);
    private static final RateLimiter.Limit SIGNALS =
            new RateLimiter.Limit("call-signal", 300, Duration.ofSeconds(10));

    private final StringRedisTemplate redis;
    private final ConversationMembership membership;
    private final RealtimeDelivery delivery;
    private final ObjectMapper mapper;
    private final RateLimiter limiter;
    private final MeterRegistry metrics;
    private final com.chatter.user.api.PrivacyDirectory privacy;

    public CallService(StringRedisTemplate redis, ConversationMembership membership,
                       RealtimeDelivery delivery, ObjectMapper mapper, RateLimiter limiter,
                       MeterRegistry metrics, com.chatter.user.api.PrivacyDirectory privacy) {
        this.privacy = privacy;
        this.redis = redis;
        this.membership = membership;
        this.delivery = delivery;
        this.mapper = mapper;
        this.limiter = limiter;
        this.metrics = metrics;
    }

    record Entry(UUID userId, boolean video, long lastSeen) {
    }

    /**
     * Joins, or refreshes membership of, the call in a conversation. The first joiner starts the
     * call and every other member's devices ring. Later joiners are announced to those already
     * in the call, who then send them offers -- existing participants always offer to the
     * newcomer, never the reverse, which avoids most offer glare.
     *
     * @return who else is in the call
     */
    public List<Frames.CallParticipant> join(UUID userId, UUID deviceId, UUID conversationId, boolean video) {
        membership.assertMember(userId, conversationId);
        Map<UUID, Entry> present = live(conversationId);
        boolean alreadyIn = present.containsKey(deviceId);
        if (!alreadyIn && present.size() >= MAX_PARTICIPANTS) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "This call is full (" + MAX_PARTICIPANTS + " people)");
        }

        UUID callId;
        if (present.isEmpty()) {
            callId = Ids.next();
            redis.opsForValue().set(idKey(conversationId), callId.toString(), KEY_TTL);
        } else {
            String existing = redis.opsForValue().get(idKey(conversationId));
            callId = existing == null ? Ids.next() : UUID.fromString(existing);
        }
        put(conversationId, deviceId, new Entry(userId, video, System.currentTimeMillis()));
        redis.opsForValue().set(deviceKey(deviceId), conversationId.toString(), KEY_TTL);
        redis.expire(idKey(conversationId), KEY_TTL);

        if (present.isEmpty()) {
            metrics.counter("chatter.calls.started", "video", Boolean.toString(video)).increment();
            // Every device of every member rings -- including the caller's own other devices,
            // which need to know a call is in progress on this account.
            List<UUID> members = membership.activeMemberIds(conversationId);
            java.util.Set<UUID> blockers = privacy.whoBlocked(userId, members);
            delivery.notifyUsersExceptDevice(members.stream().filter(m -> !blockers.contains(m)).toList(),
                    Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("RING", conversationId,
                            callId, userId, deviceId, video, null, null)),
                    deviceId);
        } else if (!alreadyIn) {
            Envelope joined = Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("JOINED",
                    conversationId, callId, userId, deviceId, video, null, null));
            delivery.deliverToDevices(present.entrySet().stream()
                    .map(e -> new RealtimeDelivery.DeviceEnvelope(e.getValue().userId(), e.getKey(), joined))
                    .toList());
        }

        List<Frames.CallParticipant> others = new ArrayList<>();
        present.forEach((device, entry) -> {
            if (!device.equals(deviceId)) {
                others.add(new Frames.CallParticipant(entry.userId(), device, entry.video()));
            }
        });
        return others;
    }

    public void leave(UUID userId, UUID deviceId, UUID conversationId) {
        redis.opsForHash().delete(callKey(conversationId), deviceId.toString());
        redis.delete(deviceKey(deviceId));
        Map<UUID, Entry> remaining = live(conversationId);
        String callId = redis.opsForValue().get(idKey(conversationId));
        UUID call = callId == null ? null : UUID.fromString(callId);

        if (remaining.isEmpty()) {
            redis.delete(List.of(callKey(conversationId), idKey(conversationId)));
            // Stops the ringing on every device that has not answered.
            delivery.notifyUsers(membership.activeMemberIds(conversationId),
                    Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("ENDED", conversationId,
                            call, userId, deviceId, null, null, null)));
            return;
        }
        Envelope left = Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("LEFT",
                conversationId, call, userId, deviceId, null, null, null));
        delivery.deliverToDevices(remaining.entrySet().stream()
                .map(e -> new RealtimeDelivery.DeviceEnvelope(e.getValue().userId(), e.getKey(), left))
                .toList());
    }

    /** The socket went away without a goodbye: treat it as leaving whatever call it was in. */
    public void disconnected(UUID userId, UUID deviceId) {
        String conversation = redis.opsForValue().get(deviceKey(deviceId));
        if (conversation != null) {
            leave(userId, deviceId, UUID.fromString(conversation));
        }
    }

    /**
     * Relays one encrypted signal. Both ends must be in the call: a member cannot use this to
     * push traffic at a device that never joined, and a non-member cannot use it at all.
     */
    public void signal(UUID userId, UUID deviceId, Frames.CallSignal signal) {
        limiter.check(SIGNALS, deviceId.toString());
        Map<UUID, Entry> present = live(signal.conversationId());
        Entry target = present.get(signal.toDeviceId());
        if (!present.containsKey(deviceId) || target == null) {
            throw AppException.forbidden("Both devices must be in the call");
        }
        delivery.deliverToDevices(List.of(new RealtimeDelivery.DeviceEnvelope(target.userId(), signal.toDeviceId(),
                Envelope.of(EnvelopeType.CALL_SIGNAL, new Frames.CallSignalFrom(signal.conversationId(),
                        userId, deviceId, signal.cipherType(), signal.ciphertext())))));
    }

    /** Current participants, pruning any that stopped heart-beating. */
    private Map<UUID, Entry> live(UUID conversationId) {
        Map<Object, Object> raw = redis.opsForHash().entries(callKey(conversationId));
        long cutoff = System.currentTimeMillis() - STALE_AFTER.toMillis();
        Map<UUID, Entry> result = new java.util.HashMap<>();
        raw.forEach((device, json) -> {
            try {
                Entry entry = mapper.readValue((String) json, Entry.class);
                if (entry.lastSeen() >= cutoff) {
                    result.put(UUID.fromString((String) device), entry);
                } else {
                    redis.opsForHash().delete(callKey(conversationId), device);
                }
            } catch (JsonProcessingException e) {
                redis.opsForHash().delete(callKey(conversationId), device);
            }
        });
        return result;
    }

    private void put(UUID conversationId, UUID deviceId, Entry entry) {
        try {
            redis.opsForHash().put(callKey(conversationId), deviceId.toString(), mapper.writeValueAsString(entry));
            redis.expire(callKey(conversationId), KEY_TTL);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String callKey(UUID conversationId) {
        return "call:" + conversationId;
    }

    private static String idKey(UUID conversationId) {
        return "call:" + conversationId + ":id";
    }

    private static String deviceKey(UUID deviceId) {
        return "call-device:" + deviceId;
    }
}
