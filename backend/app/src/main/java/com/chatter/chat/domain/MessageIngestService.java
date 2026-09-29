package com.chatter.chat.domain;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.persistence.ConversationEntity;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.chat.persistence.ConversationRepository;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.platform.config.KafkaTopicsConfig;
import com.chatter.platform.outbox.OutboxWriter;
import com.chatter.platform.ratelimit.Limits;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Message ingest. Note what this class does <em>not</em> do: it never calls the gateway. Delivery
 * is triggered by the outbox relay, so a delivery failure can never roll back a persisted message
 * and a persisted message can never fail to be delivered eventually (LLD DD-6).
 */
@Service
public class MessageIngestService {

    /** Encoding of server-authored timeline events. Their payload is JSON, not ciphertext. */
    public static final String SYSTEM_ENCODING = "system/v1";
    private static final String SIGNAL_ENCODING = "signal/v3";
    /** Stands in for a sending device on server-authored events; no real device has it. */
    private static final UUID SYSTEM_DEVICE = new UUID(0L, 0L);

    private static final Logger log = LoggerFactory.getLogger(MessageIngestService.class);
    private static final Base64.Decoder DECODER = Base64.getDecoder();
    private static final Base64.Encoder ENCODER = Base64.getEncoder();

    private final MessageStore messageStore;
    private final ConversationSequencer sequencer;
    private final MembershipGuard membershipGuard;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final DeviceDirectory devices;
    private final OutboxWriter outbox;
    private final IdempotencyCache idempotency;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final com.chatter.user.api.PrivacyDirectory privacy;
    private final com.chatter.platform.ratelimit.RateLimiter limiter;
    private final io.micrometer.core.instrument.MeterRegistry metrics;
    private final org.springframework.beans.factory.ObjectProvider<io.micrometer.tracing.Tracer> tracer;

    public MessageIngestService(MessageStore messageStore, ConversationSequencer sequencer,
                                MembershipGuard membershipGuard, ConversationRepository conversations,
                                ConversationMemberRepository members, DeviceDirectory devices,
                                OutboxWriter outbox, IdempotencyCache idempotency, JdbcTemplate jdbc,
                                ObjectMapper mapper, com.chatter.platform.ratelimit.RateLimiter limiter,
                                com.chatter.user.api.PrivacyDirectory privacy,
                                io.micrometer.core.instrument.MeterRegistry metrics,
                                org.springframework.beans.factory.ObjectProvider<io.micrometer.tracing.Tracer> tracer) {
        this.messageStore = messageStore;
        this.sequencer = sequencer;
        this.membershipGuard = membershipGuard;
        this.conversations = conversations;
        this.members = members;
        this.devices = devices;
        this.outbox = outbox;
        this.idempotency = idempotency;
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.limiter = limiter;
        this.privacy = privacy;
        this.metrics = metrics;
        this.tracer = tracer;
    }

    @Transactional
    public ChatDtos.IngestResult ingest(ChatDtos.IngestRequest request) {
        limiter.check(Limits.SEND_PER_DEVICE, request.senderDeviceId().toString());
        // The two ids that make one message greppable end to end (HLD section 6). Both are
        // routing metadata the server already has; neither reveals content.
        io.micrometer.tracing.Tracer t = tracer.getIfAvailable();
        if (t != null && t.currentSpan() != null) {
            t.currentSpan()
                    .tag("conversation_id", request.conversationId().toString())
                    .tag("client_message_id", request.clientMessageId().toString());
        }
        ConversationMemberEntity sender = members
                .findActiveMember(request.conversationId(), request.senderId())
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));

        // Fast path: Redis remembers recent client message ids. Slow path: the durable table.
        Optional<MessageStore.StoredMessage> alreadySent =
                idempotency.lookup(request.senderDeviceId(), request.clientMessageId())
                        .or(() -> messageStore.findByClientMessageId(
                                request.senderDeviceId(), request.clientMessageId()));
        if (alreadySent.isPresent()) {
            MessageStore.StoredMessage existing = alreadySent.get();
            // Returning the original result rather than an error is the point of the whole
            // scheme: a retry has to be indistinguishable from success.
            return new ChatDtos.IngestResult(existing.id(), existing.clientMessageId(),
                    existing.seq(), existing.createdAt().toEpochMilli(), true,
                    millisOrNull(existing.expiresAt()));
        }

        ConversationEntity conversation = conversations.findById(request.conversationId())
                .orElseThrow(() -> AppException.notFound("Conversation"));
        if (conversation.isOnlyAdminsCanPost() && !sender.isAdmin()) {
            throw AppException.forbidden("Only admins can send messages to this group");
        }

        applyControl(request);

        List<MessageStore.DevicePayload> payloads = withoutBlockers(address(request, conversation), request, conversation);
        byte[] groupCiphertext = request.groupCiphertext() == null
                ? null : DECODER.decode(request.groupCiphertext());

        MessageStore.StoredMessage stored = append(conversation, request.senderId(),
                request.senderDeviceId(), request.clientMessageId(), SIGNAL_ENCODING, payloads,
                groupCiphertext, request.isSilent(), request.mentions() == null ? List.of() : request.mentions());
        if (!request.isSilent()) {
            bumpUnreadCounters(request);
        }

        idempotency.remember(request.senderDeviceId(), request.clientMessageId(), stored);
        metrics.counter("chatter.messages.ingested",
                "kind", request.editOf() != null ? "edit" : request.deleteOf() != null ? "delete"
                        : request.isSilent() ? "control" : "message").increment();

        return new ChatDtos.IngestResult(stored.id(), request.clientMessageId(), stored.seq(),
                stored.createdAt().toEpochMilli(), false, millisOrNull(stored.expiresAt()));
    }

    /** FR-3.10: edits within 15 minutes. FR-3.11: delete for everyone within 2 hours. */
    private static final java.time.Duration EDIT_WINDOW = java.time.Duration.ofMinutes(15);
    private static final java.time.Duration DELETE_WINDOW = java.time.Duration.ofHours(2);

    /**
     * Enforces what clients would otherwise have to be trusted with: only the author may edit or
     * delete, only within the window, only in the same conversation. A delete also purges the
     * target's ciphertext here, in the same transaction as the delete notice.
     */
    private void applyControl(ChatDtos.IngestRequest request) {
        if (request.editOf() != null && request.deleteOf() != null) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "A message cannot be both an edit and a delete");
        }
        UUID targetId = request.editOf() != null ? request.editOf() : request.deleteOf();
        if (targetId == null) {
            return;
        }
        MessageStore.MessageMeta target = messageStore.findMeta(targetId)
                .filter(m -> m.conversationId().equals(request.conversationId()))
                .orElseThrow(() -> AppException.notFound("Message"));
        if (!target.senderId().equals(request.senderId()) || SYSTEM_ENCODING.equals(target.encoding())) {
            throw AppException.forbidden("You can only change your own messages");
        }
        if (target.deletedForAll()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "That message was deleted");
        }
        Instant now = Instant.now();
        if (request.editOf() != null) {
            if (target.createdAt().plus(EDIT_WINDOW).isBefore(now)) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Messages can only be edited for 15 minutes");
            }
            messageStore.markEdited(targetId, now);
        } else {
            if (target.createdAt().plus(DELETE_WINDOW).isBefore(now)) {
                throw new AppException(ErrorCode.VALIDATION_FAILED,
                        "Messages can only be deleted for everyone within 2 hours");
            }
            messageStore.markDeletedForAll(targetId);
        }
    }

    /**
     * FR-2.2 in a direct chat: if the recipient blocked the sender, the message is accepted and
     * the sender sees one tick, but nothing is addressed to the recipient's devices. The sender
     * is not told, which is the behaviour people expect from a block. Groups are unaffected.
     */
    private List<MessageStore.DevicePayload> withoutBlockers(List<MessageStore.DevicePayload> payloads,
                                                             ChatDtos.IngestRequest request,
                                                             ConversationEntity conversation) {
        if (conversation.isGroup()) {
            return payloads;
        }
        java.util.Set<UUID> blockers = privacy.whoBlocked(request.senderId(),
                payloads.stream().map(MessageStore.DevicePayload::recipientUserId).distinct().toList());
        return blockers.isEmpty() ? payloads
                : payloads.stream().filter(p -> !blockers.contains(p.recipientUserId())).toList();
    }

    private static Long millisOrNull(Instant instant) {
        return instant == null ? null : instant.toEpochMilli();
    }

    /**
     * Appends a server-authored event ("Alice added Bob") to a group's timeline. It rides the
     * ordinary message path -- sequenced, persisted, fanned out, synced -- so a member who was
     * offline learns about membership changes the same way they learn about messages, with no
     * second catch-up mechanism to drift out of step.
     *
     * <p>Joins the caller's transaction: the event exists if and only if the change does.
     *
     * @param alsoNotify users who are no longer members but must still hear about this one
     *                   event, such as the person who was just removed
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void postSystemEvent(UUID conversationId, GroupEvent event, Collection<UUID> alsoNotify) {
        ConversationEntity conversation = conversations.findById(conversationId)
                .orElseThrow(() -> AppException.notFound("Conversation"));

        Set<UUID> recipients = new LinkedHashSet<>(membershipGuard.activeMemberIds(conversationId));
        recipients.addAll(alsoNotify);

        List<MessageStore.DevicePayload> targets = devices.findByUsers(List.copyOf(recipients))
                .stream()
                .filter(DeviceDto::hasKeys)
                .map(d -> new MessageStore.DevicePayload(d.userId(), d.id(), 0, null))
                .toList();

        byte[] json;
        try {
            json = mapper.writeValueAsBytes(event);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot serialise group event", e);
        }
        append(conversation, event.actorId(), SYSTEM_DEVICE, Ids.next(), SYSTEM_ENCODING, targets,
                json, true, List.of());
    }

    private MessageStore.StoredMessage append(ConversationEntity conversation, UUID senderId,
                                              UUID senderDeviceId, UUID clientMessageId,
                                              String encoding,
                                              List<MessageStore.DevicePayload> payloads,
                                              byte[] groupCiphertext, boolean silent,
                                              List<UUID> mentions) {
        long seq = sequencer.next(conversation.getId());
        Instant now = Instant.now();
        UUID messageId = Ids.next();
        // Fixed at send time from the timer in force now. Timeline events never expire: the
        // notice that the timer was switched on has to outlive the messages it applies to.
        Instant expiresAt = conversation.getDisappearingSeconds() > 0 && !SYSTEM_ENCODING.equals(encoding)
                ? now.plusSeconds(conversation.getDisappearingSeconds()) : null;

        MessageStore.StoredMessage stored = messageStore.append(new MessageStore.NewMessage(
                messageId, conversation.getId(), seq, clientMessageId, senderId, senderDeviceId,
                encoding, now, payloads, groupCiphertext, expiresAt));

        conversation.recordMessage(seq, now);
        if (!SYSTEM_ENCODING.equals(encoding)) {
            writeInboxPointers(conversation.getId(), senderId, payloads, seq, now);
        }

        outbox.enqueue(KafkaTopicsConfig.MESSAGE_CREATED, conversation.getId(),
                new MessageCreatedEvent(
                        messageId, clientMessageId, conversation.getId(), senderId,
                        senderDeviceId, seq, encoding, now.toEpochMilli(),
                        payloads.stream()
                                .map(p -> new MessageCreatedEvent.Target(
                                        p.recipientUserId(), p.recipientDeviceId(),
                                        p.cipherType(),
                                        p.ciphertext() == null
                                                ? null : ENCODER.encodeToString(p.ciphertext())))
                                .toList(),
                        groupCiphertext == null ? null : ENCODER.encodeToString(groupCiphertext),
                        millisOrNull(expiresAt), silent, mentions));
        return stored;
    }

    /**
     * Works out which devices get this message and with what.
     *
     * <p>Pairwise (DIRECT, or a group sent without sender keys): the sender must address every
     * device of every member, or someone silently never receives the message. We reject an
     * under-addressed send rather than deliver a partial one.
     *
     * <p>Sender keys (GROUP with a group ciphertext): the server fills in every member device
     * itself, attaching the pairwise payload only where the sender supplied one -- those are the
     * sender-key distributions for devices that do not have the key yet.
     *
     * <p>Either way, a payload addressed to a device outside the conversation is refused. Without
     * that check a member could quietly copy a non-member into the conversation's traffic.
     */
    private List<MessageStore.DevicePayload> address(ChatDtos.IngestRequest request,
                                                     ConversationEntity conversation) {
        List<UUID> memberIds = membershipGuard.activeMemberIds(request.conversationId());
        Map<UUID, DeviceDto> expected = devices.findByUsers(memberIds).stream()
                .filter(DeviceDto::hasKeys)
                // The sending device decrypts nothing of its own, so it is not addressed.
                .filter(d -> !d.id().equals(request.senderDeviceId()))
                .collect(Collectors.toMap(DeviceDto::id, Function.identity()));

        Map<UUID, ChatDtos.PayloadDto> addressed = new java.util.HashMap<>();
        for (ChatDtos.PayloadDto p : request.payloads()) {
            DeviceDto device = expected.get(p.recipientDeviceId());
            if (device == null || !device.userId().equals(p.recipientUserId())) {
                throw new AppException(ErrorCode.VALIDATION_FAILED,
                        "Message is addressed to a device outside this conversation");
            }
            addressed.put(p.recipientDeviceId(), p);
        }

        boolean senderKeys = request.groupCiphertext() != null;
        if (senderKeys && !conversation.isGroup()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "Sender-key messages are only valid in groups");
        }
        if (!senderKeys && !addressed.keySet().containsAll(expected.keySet())) {
            Set<UUID> missing = expected.keySet().stream()
                    .filter(id -> !addressed.containsKey(id))
                    .collect(Collectors.toSet());
            log.warn("Send to conversation {} is missing payloads for devices {}",
                    request.conversationId(), missing);
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "Message is not addressed to every recipient device; refresh keys and retry");
        }
        if (!senderKeys && addressed.isEmpty() && !expected.isEmpty()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Message has no payloads");
        }

        List<MessageStore.DevicePayload> result = new ArrayList<>(expected.size());
        for (DeviceDto device : expected.values()) {
            ChatDtos.PayloadDto p = addressed.get(device.id());
            result.add(p == null
                    ? new MessageStore.DevicePayload(device.userId(), device.id(), 0, null)
                    : new MessageStore.DevicePayload(device.userId(), device.id(),
                    p.cipherType(), DECODER.decode(p.ciphertext())));
        }
        return result;
    }

    private void writeInboxPointers(UUID conversationId, UUID senderId,
                                    List<MessageStore.DevicePayload> payloads, long seq,
                                    Instant now) {
        List<UUID> recipients = payloads.stream()
                .map(MessageStore.DevicePayload::recipientUserId)
                .distinct()
                .filter(userId -> !userId.equals(senderId))
                .toList();

        if (recipients.isEmpty()) {
            return;
        }
        jdbc.batchUpdate("""
                        INSERT INTO inbox (user_id, conversation_id, seq, state, created_at)
                        VALUES (?, ?, ?, 0, ?)
                        ON CONFLICT DO NOTHING
                        """,
                recipients, recipients.size(),
                (ps, userId) -> {
                    ps.setObject(1, userId);
                    ps.setObject(2, conversationId);
                    ps.setLong(3, seq);
                    ps.setTimestamp(4, java.sql.Timestamp.from(now));
                });
    }

    private void bumpUnreadCounters(ChatDtos.IngestRequest request) {
        for (ConversationMemberEntity member : members.findActiveMembers(request.conversationId())) {
            if (!member.getId().getUserId().equals(request.senderId())) {
                member.incrementUnread();
            }
        }
    }
}
