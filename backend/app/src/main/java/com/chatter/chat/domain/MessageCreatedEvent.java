package com.chatter.chat.domain;

import java.util.List;
import java.util.UUID;

/**
 * Published through the outbox, consumed by the fan-out worker. Carries the ciphertexts so the
 * worker never has to read them back from the database on the hot path.
 */
public record MessageCreatedEvent(
        UUID messageId,
        UUID clientMessageId,
        UUID conversationId,
        UUID senderId,
        UUID senderDeviceId,
        long seq,
        String encoding,
        long createdAt,
        List<Target> targets,
        /* base64; the shared sender-key payload, or system JSON. Null for pairwise messages. */
        String groupCiphertext,
        /* epoch millis, or null */
        Long expiresAt,
        /* control message (reaction, edit, delete): delivered, but never notified */
        boolean silent,
        /* users @mentioned: notified even if they muted the chat */
        List<UUID> mentions
) {

    /** {@code ciphertext} is null for a group-message target that already holds the sender key. */
    public record Target(UUID userId, UUID deviceId, int cipherType, String ciphertext) {
    }
}
