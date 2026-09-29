package com.chatter.keys.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * A one-time prekey is exactly that: vended once, then marked consumed. Rows are kept rather than
 * deleted so a replayed bundle fetch cannot silently hand out the same key twice.
 */
@Entity
@Table(name = "one_time_prekeys")
public class OneTimePreKeyEntity {

    @EmbeddedId
    private DeviceKeyId id;

    @Column(name = "public_key", nullable = false)
    private byte[] publicKey;

    @Column(name = "consumed_at")
    private Instant consumedAt;

    protected OneTimePreKeyEntity() {
    }

    public OneTimePreKeyEntity(UUID deviceId, int keyId, byte[] publicKey) {
        this.id = new DeviceKeyId(deviceId, keyId);
        this.publicKey = publicKey;
    }

    public DeviceKeyId getId() {
        return id;
    }

    public byte[] getPublicKey() {
        return publicKey;
    }

    public void consume() {
        this.consumedAt = Instant.now();
    }
}
