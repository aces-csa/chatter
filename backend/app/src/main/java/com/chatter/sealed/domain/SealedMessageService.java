package com.chatter.sealed.domain;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.platform.config.KafkaTopicsConfig;
import com.chatter.platform.outbox.OutboxWriter;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.sealed.api.SealedDtos;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Sealed sender (Signal's design, adapted): the server delivers a 1:1 message without learning
 * who sent it.
 *
 * <p>What the server sees for a sealed send: "someone who knows B's access key sent B's devices
 * these opaque blobs". No sender, no conversation, no sequence number -- a sealed message is not
 * filed under the A-B conversation at all, because in a 1:1 chat the conversation id alone names
 * the sender. The recipient learns the sender from the certificate inside the envelope.
 *
 * <p>What this deliberately gives up, and how each is covered:
 * <ul>
 *   <li>Blocking cannot be enforced on a message with no sender. The recipient's client drops
 *       sealed messages from people it blocked, and rotates its access key on block, so the
 *       blocked person falls back to identified sends that the server can refuse.</li>
 *   <li>Per-device send limits cannot apply. Limits are per source address and per recipient,
 *       and the access key means only people the recipient has messaged can use this path.</li>
 *   <li>The sender's IP address is still visible, as it is for Signal. Hiding it is a transport
 *       problem (a proxy or Tor), outside what an application protocol can fix.</li>
 * </ul>
 */
@Service
public class SealedMessageService {

    /** Undelivered sealed messages are kept as long as a device could plausibly be offline. */
    private static final Duration RETENTION = Duration.ofDays(30);
    private static final int ACCESS_KEY_BYTES = 16;
    private static final int PENDING_PAGE = 500;
    private static final Base64.Decoder DECODER = Base64.getDecoder();
    private static final Base64.Encoder ENCODER = Base64.getEncoder();

    private final JdbcTemplate jdbc;
    private final DeviceDirectory devices;
    private final OutboxWriter outbox;
    private final RateLimiter limiter;
    private final MeterRegistry metrics;

    public SealedMessageService(JdbcTemplate jdbc, DeviceDirectory devices, OutboxWriter outbox,
                                RateLimiter limiter, MeterRegistry metrics) {
        this.jdbc = jdbc;
        this.devices = devices;
        this.outbox = outbox;
        this.limiter = limiter;
        this.metrics = metrics;
    }

    /** Published through the outbox on sealed.created, keyed by recipient. */
    public record SealedCreatedEvent(UUID recipientUserId, List<Item> items) {
        public record Item(UUID id, UUID deviceId, String ciphertext, long createdAt) {
        }
    }

    /**
     * The account's current key, for its own devices. The key is account-wide -- one per user, not
     * per device -- or linked devices would each share a different one and keep invalidating the
     * others'. The server holds it anyway, to check it.
     */
    public java.util.Optional<String> accessKey(UUID userId) {
        return jdbc.query("SELECT access_key FROM unidentified_access WHERE user_id = ?",
                (rs, n) -> ENCODER.encodeToString(rs.getBytes(1)), userId).stream().findFirst();
    }

    public void setAccessKey(UUID userId, String accessKeyBase64) {
        byte[] key = decodeAccessKey(accessKeyBase64);
        jdbc.update("""
                        INSERT INTO unidentified_access (user_id, access_key) VALUES (?, ?)
                        ON CONFLICT (user_id) DO UPDATE SET access_key = EXCLUDED.access_key, updated_at = now()
                        """,
                userId, key);
    }

    /**
     * The anonymous path. Nothing here may depend on who is calling: there is no caller.
     */
    @Transactional
    public SealedDtos.SealedSendResult deliverUnidentified(UUID recipientUserId, String accessKeyHeader,
                                                           List<SealedDtos.SealedTarget> targets) {
        limiter.check(Limits.SEALED_PER_IP, Limits.clientIp());
        limiter.check(Limits.SEALED_PER_RECIPIENT, recipientUserId.toString());
        if (!accessKeyMatches(recipientUserId, accessKeyHeader)) {
            metrics.counter("chatter.sealed.sent", "outcome", "access_denied").increment();
            // Also the answer for an unknown recipient: the endpoint must not reveal who exists.
            throw new AppException(ErrorCode.UNIDENTIFIED_ACCESS_DENIED, "Send this message identified");
        }
        Set<UUID> expected = keyedDevices(recipientUserId).stream().map(DeviceDto::id).collect(Collectors.toSet());
        return store(recipientUserId, expected, targets, "unidentified");
    }

    /**
     * The sender's copy for their own other devices. Authenticated -- the server knows who you are
     * when you talk to yourself anyway -- which is what lets it leave the sending device out of
     * the set that must be addressed.
     */
    @Transactional
    public SealedDtos.SealedSendResult deliverToOwnDevices(UUID userId, UUID sendingDeviceId,
                                                           List<SealedDtos.SealedTarget> targets) {
        limiter.check(Limits.SEND_PER_DEVICE, sendingDeviceId.toString());
        Set<UUID> expected = keyedDevices(userId).stream()
                .map(DeviceDto::id)
                .filter(id -> !id.equals(sendingDeviceId))
                .collect(Collectors.toSet());
        return store(userId, expected, targets, "self");
    }

    public List<SealedDtos.PendingSealed> pending(UUID deviceId) {
        return jdbc.query("""
                        SELECT id, ciphertext, created_at FROM sealed_messages
                         WHERE recipient_device_id = ? AND expires_at > now()
                         ORDER BY created_at LIMIT ?
                        """,
                (rs, n) -> new SealedDtos.PendingSealed(
                        rs.getObject(1, UUID.class),
                        ENCODER.encodeToString(rs.getBytes(2)),
                        rs.getTimestamp(3).toInstant().toEpochMilli()),
                deviceId, PENDING_PAGE);
    }

    /** Scoped to the device, so one device can never delete another's copy. */
    public void acknowledge(UUID deviceId, List<UUID> ids) {
        jdbc.update("DELETE FROM sealed_messages WHERE recipient_device_id = ? AND id = ANY(?)",
                deviceId, ids.toArray(UUID[]::new));
    }

    @Scheduled(fixedDelayString = "PT1H", initialDelayString = "PT2M")
    public void purgeExpired() {
        int purged = jdbc.update("DELETE FROM sealed_messages WHERE expires_at <= now()");
        if (purged > 0) {
            metrics.counter("chatter.sealed.expired").increment(purged);
        }
    }

    /**
     * Every current device must be addressed, exactly once, and nothing else: a device left out
     * would silently never get the message, and one that no longer exists would pile up rows.
     */
    private SealedDtos.SealedSendResult store(UUID recipientUserId, Set<UUID> expected,
                                              List<SealedDtos.SealedTarget> targets, String kind) {
        Set<UUID> addressed = targets.stream().map(SealedDtos.SealedTarget::deviceId).collect(Collectors.toSet());
        if (addressed.size() != targets.size() || !addressed.equals(expected)) {
            metrics.counter("chatter.sealed.sent", "outcome", "devices_changed").increment();
            throw new AppException(ErrorCode.DEVICES_CHANGED, "The recipient's devices have changed");
        }
        if (targets.isEmpty()) {
            return new SealedDtos.SealedSendResult(System.currentTimeMillis());
        }

        Instant now = Instant.now();
        Timestamp createdAt = Timestamp.from(now);
        Timestamp expiresAt = Timestamp.from(now.plus(RETENTION));
        List<SealedCreatedEvent.Item> items = new ArrayList<>(targets.size());
        for (SealedDtos.SealedTarget target : targets) {
            UUID id = Ids.next();
            byte[] ciphertext;
            try {
                ciphertext = DECODER.decode(target.ciphertext());
            } catch (IllegalArgumentException e) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Ciphertext is not base64");
            }
            jdbc.update("""
                            INSERT INTO sealed_messages (id, recipient_user_id, recipient_device_id, ciphertext, created_at, expires_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """,
                    id, recipientUserId, target.deviceId(), ciphertext, createdAt, expiresAt);
            items.add(new SealedCreatedEvent.Item(id, target.deviceId(), target.ciphertext(), now.toEpochMilli()));
        }
        // Same transaction as the rows: stored and announced, or neither (LLD DD-6).
        outbox.enqueue(KafkaTopicsConfig.SEALED_CREATED, recipientUserId, new SealedCreatedEvent(recipientUserId, items));
        metrics.counter("chatter.sealed.sent", "outcome", kind).increment();
        return new SealedDtos.SealedSendResult(now.toEpochMilli());
    }

    private List<DeviceDto> keyedDevices(UUID userId) {
        return devices.findByUser(userId).stream().filter(DeviceDto::hasKeys).toList();
    }

    private boolean accessKeyMatches(UUID userId, String presented) {
        if (presented == null || presented.isBlank()) {
            return false;
        }
        byte[] candidate;
        try {
            candidate = decodeAccessKey(presented);
        } catch (AppException e) {
            return false;
        }
        List<byte[]> stored = jdbc.query("SELECT access_key FROM unidentified_access WHERE user_id = ?",
                (rs, n) -> rs.getBytes(1), userId);
        // Constant time, and compared against something even when the user has no key, so the
        // response time does not say whether the account exists.
        byte[] expected = stored.isEmpty() ? new byte[ACCESS_KEY_BYTES] : stored.get(0);
        return MessageDigest.isEqual(expected, candidate) && !stored.isEmpty();
    }

    private static byte[] decodeAccessKey(String base64) {
        byte[] key;
        try {
            key = DECODER.decode(base64);
        } catch (IllegalArgumentException e) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Access key is not base64");
        }
        if (key.length != ACCESS_KEY_BYTES) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Access key must be 16 bytes");
        }
        return key;
    }
}
