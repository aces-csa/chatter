package com.chatter.delivery.domain;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Which gateway currently holds the socket for a given device. Written by the gateway on connect
 * with a TTL, refreshed by the heartbeat, deleted on disconnect. A stale entry costs one wasted
 * publish; a missing entry means "offline", which is exactly the right default.
 */
@Component
public class RouteRegistry {

    private final StringRedisTemplate redis;

    public RouteRegistry(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public record DeviceRoute(UUID userId, UUID deviceId, String gatewayId) {
    }

    public static String key(UUID userId, UUID deviceId) {
        return "route:" + userId + ":" + deviceId;
    }

    public Optional<String> gatewayFor(UUID userId, UUID deviceId) {
        return Optional.ofNullable(redis.opsForValue().get(key(userId, deviceId)));
    }

    /**
     * Resolves a batch in one round trip and groups by gateway, so a fan-out to N devices
     * produces one publish per gateway rather than one per device.
     */
    public Map<String, List<DeviceRoute>> resolve(List<DeviceRoute> candidates) {
        if (candidates.isEmpty()) {
            return Map.of();
        }
        List<String> keys = candidates.stream()
                .map(c -> key(c.userId(), c.deviceId()))
                .toList();
        List<String> gateways = redis.opsForValue().multiGet(keys);

        Map<String, List<DeviceRoute>> byGateway = new HashMap<>();
        if (gateways == null) {
            return byGateway;
        }
        for (int i = 0; i < candidates.size(); i++) {
            String gateway = gateways.get(i);
            if (gateway != null) {
                DeviceRoute candidate = candidates.get(i);
                byGateway.computeIfAbsent(gateway, g -> new ArrayList<>())
                        .add(new DeviceRoute(candidate.userId(), candidate.deviceId(), gateway));
            }
        }
        return byGateway;
    }

    public static String channel(String gatewayId) {
        return "gw:" + gatewayId;
    }
}
