package com.chatter.auth.api;

import java.time.Instant;
import java.util.UUID;

/**
 * @param identityKey base64 Signal public identity key, or null before key registration
 */
public record DeviceDto(
        UUID id,
        UUID userId,
        String name,
        boolean hasKeys,
        String identityKey,
        Integer registrationId,
        Instant lastActiveAt,
        Instant createdAt
) {
}
