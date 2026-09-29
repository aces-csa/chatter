package com.chatter.platform.security;

import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

import java.util.UUID;

/**
 * The authenticated caller, read from the validated JWT. Static accessors rather than an argument
 * resolver so service-layer code can assert identity without threading it through every signature.
 */
public record CurrentUser(UUID userId, UUID deviceId) {

    public static CurrentUser require() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            throw new AppException(ErrorCode.AUTH_REQUIRED, "Authentication required");
        }
        return new CurrentUser(
                UUID.fromString(jwt.getSubject()),
                UUID.fromString(jwt.getClaimAsString("did")));
    }
}
