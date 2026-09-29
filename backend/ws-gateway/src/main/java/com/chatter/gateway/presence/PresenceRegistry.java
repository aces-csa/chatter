package com.chatter.gateway.presence;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Cluster-wide presence, in Redis only.
 *
 * <p>Two keys per user, on purpose:
 * <ul>
 *   <li>{@code presence:{userId}} -- a set of connected device ids with a 40s TTL. Non-empty
 *       means online. The TTL is what makes a crashed gateway's users eventually go offline,
 *       because a crashed node cannot clean up after itself.</li>
 *   <li>{@code lastseen:{userId}} -- a timestamp with no TTL. If it shared the TTL, "last seen"
 *       would vanish exactly when it becomes the only thing worth showing.</li>
 * </ul>
 *
 * <p>Presence is best-effort. The worst outcome of losing it is a stale "last seen", never a
 * lost message.
 */
@Component
public class PresenceRegistry {

    private static final Logger log = LoggerFactory.getLogger(PresenceRegistry.class);
    private static final Duration ONLINE_TTL = Duration.ofSeconds(40);

    /**
     * A page refresh disconnects and reconnects within a second. Without a grace period every
     * refresh would flicker the user offline to everyone watching them.
     */
    private static final Duration OFFLINE_GRACE = Duration.ofSeconds(15);

    static final String CHANNEL = "presence";

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "presence-grace");
                t.setDaemon(true);
                return t;
            });

    public PresenceRegistry(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis = redis;
        this.mapper = mapper;
    }

    public record PresenceState(UUID userId, String status, Long lastSeenAt) {
    }

    public void markOnline(UUID userId, UUID deviceId) {
        boolean wasOffline = !isOnline(userId);

        redis.opsForSet().add(onlineKey(userId), deviceId.toString());
        redis.expire(onlineKey(userId), ONLINE_TTL);
        touchLastSeen(userId);

        // Only broadcast the transition, not every reconnect of an already-online user.
        if (wasOffline) {
            publish(new PresenceState(userId, "online", null));
        }
    }

    public void refresh(UUID userId, UUID deviceId) {
        // Re-add rather than just EXPIRE: if the key expired during a network hiccup, the set
        // would be empty and the user would look offline while plainly still connected.
        redis.opsForSet().add(onlineKey(userId), deviceId.toString());
        redis.expire(onlineKey(userId), ONLINE_TTL);
    }

    public void markOffline(UUID userId, UUID deviceId) {
        redis.opsForSet().remove(onlineKey(userId), deviceId.toString());
        touchLastSeen(userId);

        scheduler.schedule(() -> {
            try {
                if (!isOnline(userId)) {
                    long lastSeen = touchLastSeen(userId);
                    publish(new PresenceState(userId, "offline", lastSeen));
                }
            } catch (Exception e) {
                log.warn("Offline transition failed for {}", userId, e);
            }
        }, OFFLINE_GRACE.toSeconds(), TimeUnit.SECONDS);
    }

    public boolean isOnline(UUID userId) {
        Long size = redis.opsForSet().size(onlineKey(userId));
        return size != null && size > 0;
    }

    /** Current state for a batch, for answering a fresh PRESENCE_SUB. */
    public Map<UUID, PresenceState> snapshot(Set<UUID> userIds) {
        return userIds.stream().collect(Collectors.toMap(
                userId -> userId,
                userId -> isOnline(userId)
                        ? new PresenceState(userId, "online", null)
                        : new PresenceState(userId, "offline", lastSeen(userId).orElse(null))));
    }

    private Optional<Long> lastSeen(UUID userId) {
        String value = redis.opsForValue().get(lastSeenKey(userId));
        return value == null ? Optional.empty() : Optional.of(Long.parseLong(value));
    }

    private long touchLastSeen(UUID userId) {
        long now = Instant.now().toEpochMilli();
        redis.opsForValue().set(lastSeenKey(userId), Long.toString(now));
        return now;
    }

    private void publish(PresenceState state) {
        try {
            redis.convertAndSend(CHANNEL, mapper.writeValueAsString(state));
        } catch (Exception e) {
            log.warn("Could not publish presence for {}", state.userId(), e);
        }
    }

    private static String onlineKey(UUID userId) {
        return "presence:" + userId;
    }

    private static String lastSeenKey(UUID userId) {
        return "lastseen:" + userId;
    }
}
