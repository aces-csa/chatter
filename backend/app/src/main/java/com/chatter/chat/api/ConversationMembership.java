package com.chatter.chat.api;

import java.util.List;
import java.util.UUID;

/**
 * Membership questions other modules are allowed to ask. Presence needs it to know who should
 * see a typing indicator; keeping it behind an interface is what stops presence from reaching
 * into chat's tables.
 */
public interface ConversationMembership {

    /** @throws com.chatter.common.error.AppException if the user is not an active member */
    void assertMember(UUID userId, UUID conversationId);

    List<UUID> activeMemberIds(UUID conversationId);

    boolean isMember(UUID userId, UUID conversationId);

    /** Members who have muted this conversation right now (FR-4.6, FR-8.3). */
    java.util.Set<UUID> mutedMembers(UUID conversationId);
}
