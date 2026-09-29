package com.chatter.gateway.routing;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.UUID;

/**
 * Publishes "this device's socket lives on this gateway" so the app can route a delivery without
 * broadcasting to every node.
 *
 * <p>The TTL is longer than the heartbeat interval on purpose: a missed heartbeat should not
 * make a live socket look offline, but a crashed node's entries must expire on their own, because
 * a crashed node cannot clean up after itself.
 */
@Component
public class RouteRegistry {

    private static final Duration TTL = Duration.ofSeconds(90);

    private final StringRedisTemplate redis;
    private final String gatewayId;

    public RouteRegistry(StringRedisTemplate redis,
                         @Value("${chatter.gateway.id:gw-local}") String gatewayId) {
        this.redis = redis;
        this.gatewayId = gatewayId;
    }

    public String gatewayId() {
        return gatewayId;
    }

    public void register(UUID userId, UUID deviceId) {
        redis.opsForValue().set(key(userId, deviceId), gatewayId, TTL);
    }

    public void refresh(UUID userId, UUID deviceId) {
        redis.expire(key(userId, deviceId), TTL);
    }

    public void unregister(UUID userId, UUID deviceId) {
        redis.delete(key(userId, deviceId));
    }

    public String channel() {
        return "gw:" + gatewayId;
    }

    private static String key(UUID userId, UUID deviceId) {
        return "route:" + userId + ":" + deviceId;
    }
}
