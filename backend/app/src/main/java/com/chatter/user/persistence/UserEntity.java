package com.chatter.user.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "users")
public class UserEntity {

    @Id
    private UUID id;

    @Column(name = "phone_e164", nullable = false, unique = true)
    private String phoneE164;

    @Column(name = "phone_hash", nullable = false)
    private byte[] phoneHash;

    @Column(name = "display_name", nullable = false)
    private String displayName;

    @Column(nullable = false)
    private String about = "Hey there! I am using Chatter.";

    @Column(name = "avatar_media_id")
    private UUID avatarMediaId;

    @Column(name = "avatar_data")
    private String avatarData;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected UserEntity() {
    }

    public UserEntity(UUID id, String phoneE164, byte[] phoneHash, String displayName) {
        this.id = id;
        this.phoneE164 = phoneE164;
        this.phoneHash = phoneHash;
        this.displayName = displayName;
    }

    public UUID getId() {
        return id;
    }

    public String getPhoneE164() {
        return phoneE164;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
        this.updatedAt = Instant.now();
    }

    public String getAbout() {
        return about;
    }

    public void setAbout(String about) {
        this.about = about;
        this.updatedAt = Instant.now();
    }

    public UUID getAvatarMediaId() {
        return avatarMediaId;
    }

    public String getAvatarData() {
        return avatarData;
    }
}
