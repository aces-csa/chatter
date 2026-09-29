package com.chatter.delivery.api;

import com.chatter.common.wire.Envelope;

import java.util.List;
import java.util.UUID;

/**
 * Pushes envelopes to connected devices through whichever gateway holds each socket.
 *
 * <p>This is its own module rather than part of {@code platform} because resolving a user to
 * their devices means depending on auth, and platform is the bottom layer -- it must not depend
 * upward on a feature module. The architecture test enforces that, and it caught this exact
 * mistake.
 */
public interface RealtimeDelivery {

    /** One envelope addressed to one specific device. */
    record DeviceEnvelope(UUID userId, UUID deviceId, Envelope envelope) {
    }

    /** Sends the same envelope to every online device of every listed user. */
    void notifyUsers(List<UUID> userIds, Envelope envelope);

    /**
     * @param exceptDevice a device to skip, typically the one that caused the event -- it
     *                     already knows, and echoing to it makes the client dedupe needlessly
     */
    void notifyUsersExceptDevice(List<UUID> userIds, Envelope envelope, UUID exceptDevice);

    /**
     * Sends a <em>different</em> envelope to each device. This is the message path: under E2EE
     * every device gets its own ciphertext, so there is nothing shared to broadcast.
     */
    void deliverToDevices(List<DeviceEnvelope> targeted);

    /**
     * Which of these devices hold a live socket right now. Push notifications go only to the
     * rest: a device that is connected already has the message.
     *
     * @param devices deviceId -> owning userId
     */
    java.util.Set<UUID> onlineDevices(java.util.Map<UUID, UUID> devices);
}
