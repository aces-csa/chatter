package com.chatter.chat.domain;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Catch-up. Deliberately produces the same {@link EnvelopeType#MESSAGE} envelopes the live path
 * produces: one code path for live and backlog is what stops the two from drifting apart
 * (LLD 5.2).
 */
@Service
public class MessageSyncService {

    private static final int DEFAULT_LIMIT = 500;
    private static final Base64.Encoder ENCODER = Base64.getEncoder();

    private final MessageStore messageStore;
    private final ConversationMemberRepository members;
    private final RealtimeDelivery delivery;
    private final JdbcTemplate jdbc;
    private final com.chatter.user.api.PrivacyDirectory privacy;

    public MessageSyncService(MessageStore messageStore, ConversationMemberRepository members,
                              RealtimeDelivery delivery, JdbcTemplate jdbc,
                              com.chatter.user.api.PrivacyDirectory privacy) {
        this.privacy = privacy;
        this.messageStore = messageStore;
        this.members = members;
        this.delivery = delivery;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public Frames.SyncPage sync(ChatDtos.SyncRequest request) {
        int limit = request.limit() == null ? DEFAULT_LIMIT : Math.min(request.limit(), DEFAULT_LIMIT);
        Map<UUID, Long> cursors = request.cursors() == null ? Map.of() : request.cursors();

        // Conversations the client already knows about, plus any where it has unseen payloads
        // (a newly created chat the client has never heard of).
        Set<UUID> conversationIds = new LinkedHashSet<>(cursors.keySet());
        conversationIds.addAll(members.findMembershipsOf(request.userId()).stream()
                .map(m -> m.getId().getConversationId())
                .toList());
        conversationIds.addAll(messageStore.conversationsWithBacklog(request.deviceId()));

        List<Envelope> envelopes = new ArrayList<>();
        boolean hasMore = false;

        for (UUID conversationId : conversationIds) {
            if (envelopes.size() >= limit) {
                hasMore = true;
                break;
            }
            long after = cursors.getOrDefault(conversationId, 0L);
            List<MessageStore.AddressedMessage> batch = messageStore.readForDeviceAfter(
                    request.deviceId(), conversationId, after, limit - envelopes.size());

            for (MessageStore.AddressedMessage addressed : batch) {
                MessageStore.StoredMessage m = addressed.message();
                envelopes.add(Envelope.of(EnvelopeType.MESSAGE, new Frames.Message(
                        m.id(), m.clientMessageId(), m.conversationId(), m.senderId(),
                        m.senderDeviceId(), m.seq(), m.encoding(), addressed.cipherType(),
                        encodeOrNull(addressed.ciphertext()),
                        encodeOrNull(addressed.groupCiphertext()),
                        m.createdAt().toEpochMilli(),
                        m.expiresAt() == null ? null : m.expiresAt().toEpochMilli())));
            }
        }
        return new Frames.SyncPage(envelopes, hasMore);
    }

    private static String encodeOrNull(byte[] bytes) {
        return bytes == null ? null : ENCODER.encodeToString(bytes);
    }

    /** Marks the inbox range delivered. Idempotent: replaying an older uptoSeq changes nothing. */
    @Transactional
    public void markDelivered(ChatDtos.ReceiptRequest request) {
        jdbc.update("""
                        UPDATE inbox SET state = 1, delivered_at = now()
                        WHERE user_id = ? AND conversation_id = ? AND seq <= ? AND state = 0
                        """,
                request.userId(), request.conversationId(), request.uptoSeq());

        notifyOriginalSenders(request, EnvelopeType.DELIVERED);
    }

    /**
     * Read receipts are per user, not per device: the first device to read marks it read for the
     * account and the others are told (LLD DD-10).
     */
    @Transactional
    public void markRead(ChatDtos.ReceiptRequest request) {
        jdbc.update("""
                        UPDATE inbox SET state = 2, read_at = now(), delivered_at = coalesce(delivered_at, now())
                        WHERE user_id = ? AND conversation_id = ? AND seq <= ? AND state < 2
                        """,
                request.userId(), request.conversationId(), request.uptoSeq());

        members.findActiveMember(request.conversationId(), request.userId())
                .ifPresent(m -> m.markReadUpTo(request.uptoSeq()));

        notifyOriginalSenders(request, EnvelopeType.READ);
    }

    /**
     * Pushes the receipt back to whoever sent those messages. This is the step that turns the
     * sender's one tick into two, and two into blue -- without it the delivery-state model is
     * recorded but never observed.
     *
     * <p>A READ also goes to the reader's <em>own</em> other devices, minus the one that sent it.
     * Read state is per account, so a chat you read on your laptop must stop showing an unread
     * badge on your phone.
     */
    private void notifyOriginalSenders(ChatDtos.ReceiptRequest request, EnvelopeType type) {
        List<UUID> senders = jdbc.queryForList("""
                        SELECT DISTINCT sender_id FROM messages
                        WHERE conversation_id = ? AND seq <= ? AND sender_id <> ?
                        """,
                UUID.class, request.conversationId(), request.uptoSeq(), request.userId());

        Envelope receipt = Envelope.of(type, new Frames.Receipt(
                request.conversationId(), request.uptoSeq(), request.userId()));

        if (type == EnvelopeType.READ) {
            // FR-2.4, reciprocal as on WhatsApp: turn read receipts off and you neither send
            // them nor receive them. Delivery ticks are unaffected.
            java.util.Set<UUID> off = privacy.receiptsDisabled(
                    java.util.stream.Stream.concat(senders.stream(), java.util.stream.Stream.of(request.userId())).toList());
            senders = off.contains(request.userId()) ? List.of()
                    : senders.stream().filter(s -> !off.contains(s)).toList();
        }
        delivery.notifyUsers(senders, receipt);

        if (type == EnvelopeType.READ) {
            delivery.notifyUsersExceptDevice(
                    List.of(request.userId()), receipt, request.deviceId());
        }
    }

    @Transactional(readOnly = true)
    public List<ConversationMemberEntity> membershipsOf(UUID userId) {
        return members.findMembershipsOf(userId);
    }
}
