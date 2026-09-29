package com.chatter.chat.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "conversations")
public class ConversationEntity {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String type;

    private String subject;

    private String description;

    @Column(name = "avatar_media_id")
    private UUID avatarMediaId;

    @Column(name = "created_by")
    private UUID createdBy;

    /**
     * DIRECT only. The unique constraint on this column is what makes two clients racing to open
     * the same chat converge on one conversation instead of creating two.
     */
    @Column(name = "pair_key", unique = true)
    private String pairKey;

    @Column(name = "last_seq", nullable = false)
    private long lastSeq;

    @Column(name = "last_message_at")
    private Instant lastMessageAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "only_admins_can_post", nullable = false)
    private boolean onlyAdminsCanPost;

    @Column(name = "only_admins_can_edit_info", nullable = false)
    private boolean onlyAdminsCanEditInfo = true;

    /** 0 = off. Otherwise how long each new message lives, in seconds. */
    @Column(name = "disappearing_seconds", nullable = false)
    private int disappearingSeconds;

    protected ConversationEntity() {
    }

    public static ConversationEntity direct(UUID id, String pairKey, UUID createdBy) {
        ConversationEntity c = new ConversationEntity();
        c.id = id;
        c.type = "DIRECT";
        c.pairKey = pairKey;
        c.createdBy = createdBy;
        return c;
    }

    public static ConversationEntity group(UUID id, String subject, UUID createdBy) {
        ConversationEntity c = new ConversationEntity();
        c.id = id;
        c.type = "GROUP";
        c.subject = subject;
        c.createdBy = createdBy;
        return c;
    }

    public UUID getId() {
        return id;
    }

    public String getType() {
        return type;
    }

    public String getSubject() {
        return subject;
    }

    public String getDescription() {
        return description;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }

    public boolean isGroup() {
        return "GROUP".equals(type);
    }

    public boolean isOnlyAdminsCanPost() {
        return onlyAdminsCanPost;
    }

    public boolean isOnlyAdminsCanEditInfo() {
        return onlyAdminsCanEditInfo;
    }

    public int getDisappearingSeconds() {
        return disappearingSeconds;
    }

    public void setDisappearingSeconds(int seconds) {
        this.disappearingSeconds = seconds;
    }

    /** The creator's account is being deleted; the conversation outlives it. */
    public void forgetCreator() {
        this.createdBy = null;
    }

    public void rename(String subject) {
        this.subject = subject;
    }

    public void describe(String description) {
        this.description = description;
    }

    public void configure(boolean onlyAdminsCanPost, boolean onlyAdminsCanEditInfo) {
        this.onlyAdminsCanPost = onlyAdminsCanPost;
        this.onlyAdminsCanEditInfo = onlyAdminsCanEditInfo;
    }

    public UUID getAvatarMediaId() {
        return avatarMediaId;
    }

    public long getLastSeq() {
        return lastSeq;
    }

    public Instant getLastMessageAt() {
        return lastMessageAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void recordMessage(long seq, Instant at) {
        if (seq > this.lastSeq) {
            this.lastSeq = seq;
        }
        this.lastMessageAt = at;
    }
}
