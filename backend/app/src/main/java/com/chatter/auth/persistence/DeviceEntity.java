package com.chatter.auth.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "devices")
public class DeviceEntity {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    private String name;

    private String platform;

    @Column(name = "is_primary", nullable = false)
    private boolean primaryDevice;

    /** Signal public identity key. Null until the client completes key registration. */
    @Column(name = "identity_key")
    private byte[] identityKey;

    @Column(name = "registration_id")
    private Integer registrationId;

    @Column(name = "last_active_at")
    private Instant lastActiveAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected DeviceEntity() {
    }

    public DeviceEntity(UUID id, UUID userId, String name, String platform, boolean primaryDevice) {
        this.id = id;
        this.userId = userId;
        this.name = name;
        this.platform = platform;
        this.primaryDevice = primaryDevice;
    }

    public UUID getId() {
        return id;
    }

    public UUID getUserId() {
        return userId;
    }

    public String getName() {
        return name;
    }

    public byte[] getIdentityKey() {
        return identityKey;
    }

    public Integer getRegistrationId() {
        return registrationId;
    }

    public boolean hasKeys() {
        return identityKey != null && registrationId != null;
    }

    public void registerIdentity(byte[] identityKey, int registrationId) {
        this.identityKey = identityKey;
        this.registrationId = registrationId;
    }

    public void touch() {
        this.lastActiveAt = Instant.now();
    }

    public Instant getLastActiveAt() {
        return lastActiveAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
