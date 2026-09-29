package com.chatter.presence.api;

import jakarta.validation.constraints.NotNull;

import java.util.List;
import java.util.UUID;

public final class PresenceDtos {

    private PresenceDtos() {
    }

    /**
     * The gateway asks, on behalf of a viewer, which of these users' presence it may forward.
     * Privacy is resolved here rather than in the gateway because it depends on the contact
     * graph and the user's settings, both of which are the app's data.
     */
    public record VisibilityRequest(
            @NotNull UUID viewerId,
            @NotNull List<UUID> userIds
    ) {
    }

    /**
     * @param onlineVisible   users whose online/offline state the viewer may see
     * @param lastSeenVisible the subset whose exact "last seen" timestamp the viewer may see
     */
    public record VisibilityResponse(
            List<UUID> onlineVisible,
            List<UUID> lastSeenVisible
    ) {
    }

    public record TypingRequest(
            @NotNull UUID userId,
            @NotNull UUID deviceId,
            @NotNull UUID conversationId,
            @NotNull String state
    ) {
    }
}
