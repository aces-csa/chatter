package com.chatter.chat.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "group_invites")
public class GroupInviteEntity {

    @Id
    private String code;

    @Column(name = "conversation_id", nullable = false)
    private UUID conversationId;

    @Column(name = "created_by", nullable = false)
    private UUID createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(nullable = false)
    private boolean revoked;

    protected GroupInviteEntity() {
    }

    public GroupInviteEntity(String code, UUID conversationId, UUID createdBy, Instant expiresAt) {
        this.code = code;
        this.conversationId = conversationId;
        this.createdBy = createdBy;
        this.expiresAt = expiresAt;
    }

    public String getCode() {
        return code;
    }

    public UUID getConversationId() {
        return conversationId;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public boolean isUsable(Instant now) {
        return !revoked && (expiresAt == null || expiresAt.isAfter(now));
    }

    public void revoke() {
        this.revoked = true;
    }
}
