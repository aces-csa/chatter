package com.chatter.chat.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

@Entity
@Table(name = "conversation_members")
public class ConversationMemberEntity {

    @Embeddable
    public static class Key implements Serializable {

        @Column(name = "conversation_id", nullable = false)
        private UUID conversationId;

        @Column(name = "user_id", nullable = false)
        private UUID userId;

        protected Key() {
        }

        public Key(UUID conversationId, UUID userId) {
            this.conversationId = conversationId;
            this.userId = userId;
        }

        public UUID getConversationId() {
            return conversationId;
        }

        public UUID getUserId() {
            return userId;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) {
                return true;
            }
            return o instanceof Key other
                    && Objects.equals(conversationId, other.conversationId)
                    && Objects.equals(userId, other.userId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(conversationId, userId);
        }
    }

    @EmbeddedId
    private Key id;

    @Column(nullable = false)
    private String role = "MEMBER";

    @Column(name = "joined_at", nullable = false)
    private Instant joinedAt = Instant.now();

    @Column(name = "left_at")
    private Instant leftAt;

    @Column(name = "muted_until")
    private Instant mutedUntil;

    @Column(nullable = false)
    private boolean pinned;

    @Column(nullable = false)
    private boolean archived;

    @Column(name = "last_read_seq", nullable = false)
    private long lastReadSeq;

    @Column(name = "unread_count", nullable = false)
    private int unreadCount;

    @Column(name = "marked_unread", nullable = false)
    private boolean markedUnread;

    protected ConversationMemberEntity() {
    }

    public ConversationMemberEntity(UUID conversationId, UUID userId, String role) {
        this.id = new Key(conversationId, userId);
        this.role = role;
    }

    public Key getId() {
        return id;
    }

    public String getRole() {
        return role;
    }

    public boolean isActive() {
        return leftAt == null;
    }

    public boolean isAdmin() {
        return "OWNER".equals(role) || "ADMIN".equals(role);
    }

    public boolean isOwner() {
        return "OWNER".equals(role);
    }

    public Instant getMutedUntil() {
        return mutedUntil;
    }

    public boolean isMuted(Instant now) {
        return mutedUntil != null && mutedUntil.isAfter(now);
    }

    /** @param until null to unmute */
    public void mute(Instant until) {
        this.mutedUntil = until;
    }

    public Instant getJoinedAt() {
        return joinedAt;
    }

    public void changeRole(String role) {
        this.role = role;
    }

    /** Soft delete: the row keeps read state so a re-added member does not start from zero. */
    public void leave() {
        this.leftAt = Instant.now();
    }

    public void rejoin() {
        this.leftAt = null;
        this.joinedAt = Instant.now();
        this.role = "MEMBER";
    }

    public long getLastReadSeq() {
        return lastReadSeq;
    }

    public int getUnreadCount() {
        return unreadCount;
    }

    public boolean isPinned() {
        return pinned;
    }

    public boolean isArchived() {
        return archived;
    }

    public boolean isMarkedUnread() {
        return markedUnread;
    }

    public void setPinned(boolean pinned) {
        this.pinned = pinned;
    }

    public void setArchived(boolean archived) {
        this.archived = archived;
    }

    public void setMarkedUnread(boolean markedUnread) {
        this.markedUnread = markedUnread;
    }

    public void incrementUnread() {
        this.unreadCount++;
    }

    /** Read receipts are coalesced: one call marks everything up to a sequence number. */
    public void markReadUpTo(long seq) {
        if (seq <= lastReadSeq) {
            return;
        }
        this.lastReadSeq = seq;
        this.unreadCount = 0;
        this.markedUnread = false;
    }
}
