package com.chatter.auth.api;

import java.util.UUID;

/**
 * Published after a device is removed from an account. Delivery listens and tells the device
 * over its socket, so it signs itself out now rather than when its access token lapses. An
 * event rather than a call because delivery already depends on auth; the reverse would be a cycle.
 */
public record DeviceRevokedEvent(UUID userId, UUID deviceId) {
}
