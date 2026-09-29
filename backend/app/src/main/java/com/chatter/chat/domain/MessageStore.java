package com.chatter.chat.domain;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * The seam that lets the message store change without the rest of the application noticing.
 * Phase 1 is Postgres with monthly partitions; Cassandra drops in behind this at the scale where
 * it pays for itself (LLD DD-3).
 */
public interface MessageStore {

    record StoredMessage(
            UUID id,
            UUID conversationId,
            long seq,
            UUID clientMessageId,
            UUID senderId,
            UUID senderDeviceId,
            String encoding,
            Instant createdAt,
            Instant expiresAt
    ) {
    }

    /**
     * One recipient device's pointer for one message, with its pairwise ciphertext if it has one.
     * For a group message {@code ciphertext} is null unless this device is being handed the
     * sender key (cipherType 0 when absent).
     */
    record DevicePayload(
            UUID recipientUserId,
            UUID recipientDeviceId,
            int cipherType,
            byte[] ciphertext
    ) {
    }

    record NewMessage(
            UUID id,
            UUID conversationId,
            long seq,
            UUID clientMessageId,
            UUID senderId,
            UUID senderDeviceId,
            String encoding,
            Instant createdAt,
            List<DevicePayload> payloads,
            byte[] groupCiphertext,
            /* null unless disappearing messages were on */
            Instant expiresAt
    ) {
    }

    /** A message joined with what one device may read: its own payload plus any shared one. */
    record AddressedMessage(StoredMessage message, int cipherType, byte[] ciphertext,
                            byte[] groupCiphertext) {
    }

    StoredMessage append(NewMessage message);

    /** The durable half of the idempotency guard (LLD DD-5). */
    Optional<StoredMessage> findByClientMessageId(UUID senderDeviceId, UUID clientMessageId);

    /** Catch-up read: everything this device has not seen in one conversation. */
    List<AddressedMessage> readForDeviceAfter(UUID deviceId, UUID conversationId, long afterSeq,
                                              int limit);

    /** Conversations where this device has undelivered payloads, for a cold SYNC. */
    List<UUID> conversationsWithBacklog(UUID deviceId);

    /**
     * Deletes up to {@code limit} messages whose disappearing timer has run out, with every
     * ciphertext attached to them. Returns how many went.
     */
    int purgeExpired(Instant now, int limit);

    /** A message's author, conversation, age and whether it is already deleted -- no content. */
    record MessageMeta(UUID id, UUID conversationId, UUID senderId, Instant createdAt,
                       boolean deletedForAll, String encoding) {
    }

    Optional<MessageMeta> findMeta(UUID messageId);

    /**
     * Delete for everyone: flags the row and drops every ciphertext for it, so a device that has
     * not fetched it yet never will. The row itself stays, keeping the sequence gap-free.
     */
    void markDeletedForAll(UUID messageId);

    void markEdited(UUID messageId, Instant editedAt);
}
