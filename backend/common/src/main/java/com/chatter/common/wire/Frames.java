package com.chatter.common.wire;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Payload shapes for each {@link EnvelopeType}. Grouped in one file on purpose: they are a single
 * protocol definition and reading them together is how you understand the protocol.
 */
public final class Frames {

    private Frames() {
    }

    /** S to C, immediately after a successful STOMP CONNECT. */
    public record ConnectOk(UUID userId, UUID deviceId, long serverTime) {
    }

    /**
     * One ciphertext for one recipient device. Under E2EE a single logical message fans out into
     * one of these per device, including the sender's own other devices (LLD 3.6).
     */
    public record RecipientPayload(
            UUID recipientUserId,
            UUID recipientDeviceId,
            int cipherType,
            String ciphertext
    ) {
    }

    /**
     * C to S. The server never sees plaintext; it only routes {@code payloads}.
     *
     * @param groupCiphertext groups only: one sender-key ciphertext every member device can open.
     *                        {@code payloads} then carries only the pairwise sender-key
     *                        distributions for devices that do not have the key yet, and may be empty.
     */
    public record Send(
            UUID clientMessageId,
            UUID conversationId,
            UUID replyToId,
            UUID mediaId,
            List<RecipientPayload> payloads,
            String groupCiphertext,
            /*
             * Plaintext hints for control messages (reactions, edits, deletes), which are ordinary
             * encrypted messages to everyone but the server. silent: do not count as unread or
             * notify. editOf / deleteOf: the target, so the server can enforce authorship and the
             * time windows, and purge a deleted message's ciphertext. The server learns that an
             * edit or delete happened and to which message -- never the content.
             */
            Boolean silent,
            UUID editOf,
            UUID deleteOf,
            /* FR-4.7: who is @mentioned, so a mention can notify through a muted group */
            List<UUID> mentions
    ) {
    }

    /**
     * S to C. Turns the sender's pending clock into a single tick.
     *
     * @param expiresAt epoch millis when a disappearing message is deleted, or null
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Ack(UUID clientMessageId, UUID messageId, long seq, long ts, Long expiresAt) {
    }

    /** S to C. {@code retryable} tells the client outbox whether to schedule another attempt. */
    public record Nack(UUID clientMessageId, String code, String message, boolean retryable) {
    }

    /**
     * S to C, already narrowed to what this device can decrypt.
     *
     * <p>{@code ciphertext} is this device's pairwise payload, or null (with cipherType 0) for a
     * group message it already holds the sender key for. {@code groupCiphertext} is the shared
     * sender-key payload; for {@code encoding = "system/v1"} it is server-written JSON instead.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Message(
            UUID messageId,
            UUID clientMessageId,
            UUID conversationId,
            UUID senderId,
            UUID senderDeviceId,
            long seq,
            String encoding,
            int cipherType,
            String ciphertext,
            String groupCiphertext,
            long createdAt,
            /* epoch millis; null unless the chat had disappearing messages on when this was sent */
            Long expiresAt
    ) {
    }

    /**
     * Both directions. Carries {@code uptoSeq} rather than a list of ids, which is the difference
     * between a quiet socket and a receipt storm when someone scrolls back through a busy chat.
     */
    public record Receipt(UUID conversationId, long uptoSeq, UUID userId) {
    }

    /** C to S: the sender is implied by the authenticated socket. */
    public record Typing(UUID conversationId, String state) {
    }

    /** S to C: the recipient needs to know *who* is typing, which the inbound frame omits. */
    public record TypingFrom(UUID conversationId, UUID userId, String state) {
    }

    /**
     * @param status    "online" or "offline"
     * @param lastSeenAt epoch millis, or null when the viewer is not permitted to see it
     */
    public record Presence(UUID userId, String status, Long lastSeenAt) {
    }

    public record PresenceSub(List<UUID> userIds) {
    }

    /** C to S on connect: "here is where each of my conversations got to". */
    public record Sync(Map<UUID, Long> cursors, Integer limit) {
    }

    public record SyncPage(List<Envelope> envelopes, boolean hasMore) {
    }

    public record Error(String code, String message) {
    }

    // --- Calls ---------------------------------------------------------------------------------
    // The server keeps who is in which call (routing metadata it cannot avoid) and relays
    // signalling. It never sees SDP or ICE: those are Signal-encrypted per device pair, which is
    // what stops a malicious server swapping DTLS fingerprints to sit in the middle of the media.

    /** C to S. Also sent every 20 s while in the call, as the liveness heartbeat. */
    public record CallJoin(UUID conversationId, boolean video) {
    }

    public record CallLeave(UUID conversationId) {
    }

    /** C to S: to one device in the same call. */
    public record CallSignal(UUID conversationId, UUID toDeviceId, int cipherType, String ciphertext) {
    }

    /** S to C: the relayed signal, stamped with its authenticated sender. */
    public record CallSignalFrom(UUID conversationId, UUID fromUserId, UUID fromDeviceId,
                                 int cipherType, String ciphertext) {
    }

    public record CallParticipant(UUID userId, UUID deviceId, boolean video) {
    }

    /**
     * @param kind RING (a call started), JOINED / LEFT (one device), ENDED (last one left),
     *             ROSTER (reply to a join: who is already there), REJECTED (e.g. call full)
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CallEvent(String kind, UUID conversationId, UUID callId, UUID userId,
                            UUID deviceId, Boolean video, List<CallParticipant> participants,
                            String message) {
    }

    /** Internal: app to a specific gateway over Redis pub/sub. Not part of the client protocol. */
    public record Delivery(UUID userId, UUID deviceId, Envelope envelope) {
    }

    public record GatewayPush(List<Delivery> deliveries) {
    }
}
