package com.chatter.gateway.presence;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Which users each locally-connected device is watching.
 *
 * <p>This is the mechanism that keeps presence affordable. Broadcasting every status change to
 * every contact is O(contacts) per change -- a user with 500 contacts coming online is 500
 * pushes. Scoping it to the chats a client currently has open turns that into O(open chats),
 * which is a handful.
 *
 * <p>In-memory and per node: it dies with the socket, which is exactly its natural lifetime.
 */
@Component
public class PresenceSubscriptions {

    private final Map<UUID, Set<UUID>> watchedByDevice = new ConcurrentHashMap<>();

    /** Replaces the device's watch set; a client sends the full list it currently cares about. */
    public void watch(UUID deviceId, Set<UUID> userIds) {
        watchedByDevice.put(deviceId, Set.copyOf(userIds));
    }

    public void clear(UUID deviceId) {
        watchedByDevice.remove(deviceId);
    }

    /** Devices on this node that want to hear about the given user. */
    public Set<UUID> watchersOf(UUID userId) {
        return watchedByDevice.entrySet().stream()
                .filter(entry -> entry.getValue().contains(userId))
                .map(Map.Entry::getKey)
                .collect(java.util.stream.Collectors.toSet());
    }
}
