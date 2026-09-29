package com.chatter.platform.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * Rejects a valid JWT whose device has been revoked. Runs after bearer authentication, so it only
 * ever sees requests that already carry an authenticated device id.
 *
 * <p>Deliberately not a {@code @Component}: Spring Boot auto-registers every Filter bean into the
 * main servlet chain, which is exactly how this project once had its internal-token filter guard
 * every endpoint. It is constructed in SecurityConfig instead.
 */
public class RevokedDeviceFilter extends OncePerRequestFilter {

    private final RevokedDevices revoked;

    public RevokedDeviceFilter(RevokedDevices revoked) {
        this.revoked = revoked;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken jwt) {
            String deviceId = jwt.getToken().getClaimAsString("did");
            if (deviceId != null && revoked.isRevoked(UUID.fromString(deviceId))) {
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType("application/json");
                response.getWriter().write(
                        "{\"code\":\"AUTH_REQUIRED\",\"message\":\"This device was logged out\",\"retryable\":false}");
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
