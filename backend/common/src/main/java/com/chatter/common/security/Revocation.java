package com.chatter.common.security;

import java.time.Duration;
import java.util.UUID;

/**
 * The Redis contract for revoked devices, shared by the app (which writes it and checks REST
 * calls) and the gateway (which checks socket frames). JWTs are self-contained and valid until
 * they expire, so revoking a device needs a denylist entry that outlives its last access token.
 */
public final class Revocation {

    /** Longer than the 15-minute access token, so no token issued before revocation outlives it. */
    public static final Duration TTL = Duration.ofMinutes(20);

    private Revocation() {
    }

    public static String deviceKey(UUID deviceId) {
        return "revoked-device:" + deviceId;
    }
}
