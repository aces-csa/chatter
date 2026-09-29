package com.chatter.keys.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class DeviceKeyId implements Serializable {

    @Column(name = "device_id", nullable = false)
    private UUID deviceId;

    @Column(name = "key_id", nullable = false)
    private Integer keyId;

    protected DeviceKeyId() {
    }

    public DeviceKeyId(UUID deviceId, Integer keyId) {
        this.deviceId = deviceId;
        this.keyId = keyId;
    }

    public UUID getDeviceId() {
        return deviceId;
    }

    public Integer getKeyId() {
        return keyId;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof DeviceKeyId other
                && Objects.equals(deviceId, other.deviceId)
                && Objects.equals(keyId, other.keyId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(deviceId, keyId);
    }
}
