package com.chatter.chat.fanout;

import java.util.List;
import java.util.UUID;

/**
 * Published on {@code push.notify}, keyed by conversationId: "these devices were offline when this
 * message was fanned out". Ids only -- the server has no content to put in a notification anyway.
 */
public record PushNotifyEvent(
        UUID messageId,
        UUID conversationId,
        UUID senderId,
        long createdAt,
        /* users @mentioned: notified even if they muted the chat */
        List<UUID> mentions,
        List<Device> devices
) {

    public record Device(UUID userId, UUID deviceId) {
    }
}
