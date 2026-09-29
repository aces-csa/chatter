package com.chatter.keys.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/** Public half of a device's signed prekey, plus the identity-key signature over it. */
@Entity
@Table(name = "signed_prekeys")
public class SignedPreKeyEntity {

    @EmbeddedId
    private DeviceKeyId id;

    @Column(name = "public_key", nullable = false)
    private byte[] publicKey;

    @Column(nullable = false)
    private byte[] signature;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected SignedPreKeyEntity() {
    }

    public SignedPreKeyEntity(UUID deviceId, int keyId, byte[] publicKey, byte[] signature) {
        this.id = new DeviceKeyId(deviceId, keyId);
        this.publicKey = publicKey;
        this.signature = signature;
    }

    public DeviceKeyId getId() {
        return id;
    }

    public byte[] getPublicKey() {
        return publicKey;
    }

    public byte[] getSignature() {
        return signature;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
