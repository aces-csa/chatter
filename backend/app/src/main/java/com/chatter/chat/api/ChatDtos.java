package com.chatter.chat.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ChatDtos {

    private ChatDtos() {
    }

    public record ConversationDto(
            UUID id,
            String type,
            String subject,
            String description,
            UUID avatarMediaId,
            List<UUID> participantIds,
            List<MemberDto> members,
            boolean onlyAdminsCanPost,
            boolean onlyAdminsCanEditInfo,
            int disappearingSeconds,
            long lastSeq,
            Instant lastMessageAt,
            long lastReadSeq,
            int unreadCount,
            boolean pinned,
            boolean archived,
            /* null when not muted; far future for "always" */
            Instant mutedUntil,
            boolean markedUnread
    ) {
    }

    /** FR-7.2 / 7.3. Null fields are left unchanged. */
    public record ChatStateRequest(Boolean pinned, Boolean archived, Boolean markedUnread) {
    }

    /** FR-4.8: one recipient's progress on one message. Read is hidden where receipts are off. */
    public record MessageReceipt(UUID userId, Instant deliveredAt, Instant readAt) {
    }

    /** @param duration "8h", "1w", "always", or "off" to unmute */
    public record MuteRequest(@NotBlank String duration) {
    }

    /** @param role OWNER, ADMIN or MEMBER */
    public record MemberDto(UUID userId, String role) {
    }

    public record AddMembersRequest(@NotEmpty @Size(max = 256) List<@NotNull UUID> userIds) {
    }

    public record RoleRequest(@NotBlank String role) {
    }

    /** @param seconds 0 (off), 86400 (24 h), 604800 (7 d) or 7776000 (90 d) */
    public record DisappearingRequest(int seconds) {
    }

    /** Every field optional; null means "leave unchanged". */
    public record UpdateGroupRequest(
            @Size(min = 1, max = 100) String subject,
            @Size(max = 512) String description,
            Boolean onlyAdminsCanPost,
            Boolean onlyAdminsCanEditInfo
    ) {
    }

    /** @param expiresInHours null for a link that lasts until revoked */
    public record CreateInviteRequest(Integer expiresInHours) {
    }

    public record InviteDto(String code, Instant expiresAt) {
    }

    /** What someone holding a link sees before joining. Deliberately omits the member list. */
    public record InvitePreviewDto(UUID conversationId, String subject, String description,
                                   int memberCount, boolean alreadyMember) {
    }

    public record CreateConversationRequest(
            @NotBlank String type,
            @NotEmpty List<UUID> participantIds,
            @Size(max = 100) String subject
    ) {
    }

    /** One ciphertext for one recipient device (LLD 3.6). */
    public record PayloadDto(
            @NotNull UUID recipientUserId,
            @NotNull UUID recipientDeviceId,
            int cipherType,
            /* base64; a 65 536-char message plus Signal framing fits with room to spare */
            @NotBlank @Size(max = 262_144) String ciphertext
    ) {
    }

    /** Posted by the ws-gateway on /internal/v1/messages. */
    public record IngestRequest(
            @NotNull UUID senderId,
            @NotNull UUID senderDeviceId,
            @NotNull UUID clientMessageId,
            @NotNull UUID conversationId,
            /* 1 024 members x a few devices each */
            @NotNull @Size(max = 10_000) List<@Valid PayloadDto> payloads,
            /* groups only: base64 sender-key ciphertext shared by every member device */
            @Size(max = 262_144) String groupCiphertext,
            /* control message: no unread bump, no push */
            Boolean silent,
            UUID editOf,
            UUID deleteOf,
            /* FR-4.7: plaintext hint so a mention can reach someone who muted the group */
            @Size(max = 1024) List<UUID> mentions
    ) {

        public boolean isSilent() {
            return Boolean.TRUE.equals(silent) || editOf != null || deleteOf != null;
        }
    }

    public record IngestResult(
            UUID messageId,
            UUID clientMessageId,
            long seq,
            long createdAt,
            boolean duplicate,
            Long expiresAt
    ) {
    }

    public record ReceiptRequest(
            @NotNull UUID userId,
            @NotNull UUID deviceId,
            @NotNull UUID conversationId,
            long uptoSeq
    ) {
    }

    public record SyncRequest(
            @NotNull UUID userId,
            @NotNull UUID deviceId,
            Map<UUID, Long> cursors,
            Integer limit
    ) {
    }
}
