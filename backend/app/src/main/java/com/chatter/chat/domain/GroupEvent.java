package com.chatter.chat.domain;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.UUID;

/**
 * A membership or settings change, as it appears in the group timeline. Serialised as the body
 * of a {@code system/v1} message: plaintext, because the server authored it and already knows
 * every fact in it -- membership is routing metadata, not content.
 *
 * @param kind CREATED, MEMBERS_ADDED, MEMBER_REMOVED, MEMBER_LEFT, JOINED_VIA_INVITE,
 *             ROLE_CHANGED, SUBJECT_CHANGED, DESCRIPTION_CHANGED, SETTINGS_CHANGED,
 *             DISAPPEARING_CHANGED (also used in direct chats)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record GroupEvent(
        String kind,
        UUID actorId,
        List<UUID> userIds,
        String subject,
        String description,
        String role,
        Boolean onlyAdminsCanPost,
        Boolean onlyAdminsCanEditInfo,
        Integer disappearingSeconds
) {

    public GroupEvent(String kind, UUID actorId, List<UUID> userIds, String subject,
                      String description, String role, Boolean onlyAdminsCanPost,
                      Boolean onlyAdminsCanEditInfo) {
        this(kind, actorId, userIds, subject, description, role, onlyAdminsCanPost,
                onlyAdminsCanEditInfo, null);
    }

    public static GroupEvent of(String kind, UUID actorId, List<UUID> userIds) {
        return new GroupEvent(kind, actorId, userIds, null, null, null, null, null);
    }

    public static GroupEvent disappearing(UUID actorId, int seconds) {
        return new GroupEvent("DISAPPEARING_CHANGED", actorId, null, null, null, null, null,
                null, seconds);
    }
}
