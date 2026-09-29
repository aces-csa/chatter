package com.chatter.keys.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.UUID;

/**
 * Key material on the wire is base64. Only public halves ever reach the server: the private
 * identity key, private prekeys and all session state stay in the browser (LLD 6A.1).
 */
public final class KeyDtos {

    private KeyDtos() {
    }

    public record SignedPreKeyDto(
            @NotNull Integer keyId,
            @NotBlank String publicKey,
            @NotBlank String signature
    ) {
    }

    public record PreKeyDto(
            @NotNull Integer keyId,
            @NotBlank String publicKey
    ) {
    }

    public record RegisterKeysRequest(
            @NotBlank String identityKey,
            @NotNull Integer registrationId,
            @NotNull @Valid SignedPreKeyDto signedPreKey,
            @NotNull @Size(max = 200) List<@Valid PreKeyDto> oneTimePreKeys
    ) {
    }

    /** Extra one-time prekeys only; identity and signed prekey are unchanged. */
    public record TopUpRequest(
            @NotNull @Size(max = 200) List<@Valid PreKeyDto> oneTimePreKeys
    ) {
    }

    public record PreKeyCount(int available, int highestKeyId) {
    }

    /**
     * One bundle per device. {@code preKey} is null when the device has run out of one-time
     * prekeys -- X3DH still works from the signed prekey alone, losing forward secrecy for that
     * first message only, so the client proceeds and the server counts the event.
     */
    public record DeviceBundle(
            UUID deviceId,
            int registrationId,
            String identityKey,
            SignedPreKeyDto signedPreKey,
            PreKeyDto preKey
    ) {
    }

    public record UserBundles(UUID userId, List<DeviceBundle> devices) {
    }
}
