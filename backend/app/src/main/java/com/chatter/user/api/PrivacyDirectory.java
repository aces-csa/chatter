package com.chatter.user.api;

import java.time.Instant;
import java.util.Collection;
import java.util.Set;
import java.util.UUID;

/** Privacy and blocking questions other modules may ask (FR-2.2, 2.4, 8.4). */
public interface PrivacyDirectory {

    boolean isBlocked(UUID blocker, UUID blocked);

    /** Of these users, the ones who have blocked {@code sender}. */
    Set<UUID> whoBlocked(UUID sender, Collection<UUID> users);

    /** Users who turned read receipts off: they neither send nor receive them. */
    Set<UUID> receiptsDisabled(Collection<UUID> users);

    /** Users whose quiet hours include {@code now} in their own time zone. */
    Set<UUID> inQuietHours(Collection<UUID> users, Instant now);
}
