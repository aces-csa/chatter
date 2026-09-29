package com.chatter.gateway.ws;

import java.security.Principal;
import java.util.UUID;

/**
 * The authenticated socket identity. Spring's user destinations key off {@link #getName()}, so
 * the name is the device id rather than the user id: each device is addressed separately because
 * under E2EE each device receives a different ciphertext.
 */
public record SocketPrincipal(UUID userId, UUID deviceId, java.time.Instant tokenExpiresAt)
        implements Principal {

    @Override
    public String getName() {
        return deviceId.toString();
    }
}
