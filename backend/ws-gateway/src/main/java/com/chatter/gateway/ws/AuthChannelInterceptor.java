package com.chatter.gateway.ws;

import com.chatter.common.security.Revocation;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Authenticates the socket on CONNECT, then keeps checking two things on every inbound frame:
 *
 * <ul>
 *   <li><b>Token expiry.</b> A socket used to outlive its 15-minute token indefinitely. Now a
 *       frame after expiry is refused with {@code AUTH_EXPIRED}; the client refreshes and
 *       reconnects, which is the in-band refresh LLD 3.4 describes.</li>
 *   <li><b>Revocation.</b> A logged-out device's frames are refused with {@code DEVICE_REVOKED}.
 *       The answer is cached for a few seconds per device, so the hot path does not hit Redis
 *       on every message.</li>
 * </ul>
 * Error codes travel in the exception message, which Spring puts in the STOMP ERROR frame.
 */
@Component
public class AuthChannelInterceptor implements ChannelInterceptor {

    private static final Logger log = LoggerFactory.getLogger(AuthChannelInterceptor.class);
    /** Clock skew and in-flight frames: a token a few seconds past expiry is not an attack. */
    private static final Duration EXPIRY_GRACE = Duration.ofSeconds(60);
    private static final long REVOCATION_CACHE_MS = 5_000;

    private final JwtDecoder jwtDecoder;
    private final StringRedisTemplate redis;
    private final GatewayDrain drain;
    private final MeterRegistry metrics;
    private final Map<UUID, long[]> revocationCache = new ConcurrentHashMap<>();

    public AuthChannelInterceptor(JwtDecoder jwtDecoder, StringRedisTemplate redis,
                                  GatewayDrain drain, MeterRegistry metrics) {
        this.jwtDecoder = jwtDecoder;
        this.redis = redis;
        this.drain = drain;
        this.metrics = metrics;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() == null) {
            return message;
        }
        if (StompCommand.CONNECT.equals(accessor.getCommand())) {
            return authenticate(message, accessor);
        }
        if (StompCommand.DISCONNECT.equals(accessor.getCommand())) {
            return message;
        }
        if (accessor.getUser() instanceof SocketPrincipal who) {
            if (isRevoked(who.deviceId())) {
                reject("DEVICE_REVOKED", "This device was logged out");
            }
            if (who.tokenExpiresAt() != null && Instant.now().isAfter(who.tokenExpiresAt().plus(EXPIRY_GRACE))) {
                reject("AUTH_EXPIRED", "Access token expired; reconnect with a fresh one");
            }
        }
        return message;
    }

    private Message<?> authenticate(Message<?> message, StompHeaderAccessor accessor) {
        if (drain.isDraining()) {
            reject("GATEWAY_DRAINING", "This node is shutting down; reconnect");
        }
        String token = bearerToken(accessor);
        if (token == null) {
            throw new IllegalArgumentException("Missing Authorization header on CONNECT");
        }
        try {
            Jwt jwt = jwtDecoder.decode(token);
            SocketPrincipal principal = new SocketPrincipal(
                    UUID.fromString(jwt.getSubject()),
                    UUID.fromString(jwt.getClaimAsString("did")),
                    jwt.getExpiresAt());
            if (isRevoked(principal.deviceId())) {
                reject("DEVICE_REVOKED", "This device was logged out");
            }
            accessor.setUser(principal);
            log.debug("Socket authenticated for user={} device={}",
                    principal.userId(), principal.deviceId());
        } catch (JwtException e) {
            // Rejecting here closes the socket before it is established, which is what we want:
            // an unauthenticated socket must never reach a message handler.
            metrics.counter("chatter.gateway.frames.rejected", "reason", "INVALID_TOKEN").increment();
            throw new IllegalArgumentException("AUTH_EXPIRED: invalid or expired access token", e);
        }
        return message;
    }

    private boolean isRevoked(UUID deviceId) {
        long now = System.currentTimeMillis();
        long[] cached = revocationCache.get(deviceId);
        if (cached != null && now - cached[0] < REVOCATION_CACHE_MS) {
            return cached[1] == 1;
        }
        boolean revoked;
        try {
            revoked = Boolean.TRUE.equals(redis.hasKey(Revocation.deviceKey(deviceId)));
        } catch (DataAccessException e) {
            revoked = false; // fail open, as the app does
        }
        revocationCache.put(deviceId, new long[]{now, revoked ? 1 : 0});
        return revoked;
    }

    private void reject(String code, String detail) {
        metrics.counter("chatter.gateway.frames.rejected", "reason", code).increment();
        throw new MessageDeliveryException(code + ": " + detail);
    }

    private static String bearerToken(StompHeaderAccessor accessor) {
        List<String> header = accessor.getNativeHeader("Authorization");
        if (header == null || header.isEmpty()) {
            return null;
        }
        String value = header.getFirst();
        return value != null && value.startsWith("Bearer ") ? value.substring(7) : value;
    }
}
