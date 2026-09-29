package com.chatter.sealed.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.UUID;

/** Wire shapes for sealed sender. Byte fields are base64. */
public final class SealedDtos {

    private SealedDtos() {
    }

    /**
     * @param certificate the signed JSON bytes: userId, deviceId, identityKey, expires
     * @param signature   ECDSA P-256, raw r||s, over exactly those bytes
     */
    public record SenderCertificate(String certificate, String signature, long expiresAt) {
    }

    public record TrustRoot(String publicKey) {
    }

    public record AccessKey(@NotBlank @Size(max = 64) String accessKey) {
    }

    /** One sealed envelope for one recipient device. ~64 KB is plenty: media travels as a key. */
    public record SealedTarget(@NotNull UUID deviceId, @NotBlank @Size(max = 90_000) String ciphertext) {
    }

    public record SealedSendRequest(@NotEmpty @Size(max = 20) List<@Valid SealedTarget> targets) {
    }

    public record SealedSendResult(long createdAt) {
    }

    /** A stored envelope waiting for this device, as returned by the catch-up fetch. */
    public record PendingSealed(UUID id, String ciphertext, long createdAt) {
    }

    public record AckRequest(@NotEmpty @Size(max = 500) List<@NotNull UUID> ids) {
    }
}
