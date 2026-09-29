package com.chatter.chat.domain;

import com.chatter.chat.api.ConversationMembership;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.common.error.AppException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Every conversation-scoped operation, REST or WebSocket, goes through here. One place to get
 * authorization wrong means one place to get it right.
 */
@Component
public class MembershipGuard implements ConversationMembership {

    private final ConversationMemberRepository members;

    public MembershipGuard(ConversationMemberRepository members) {
        this.members = members;
    }

    @Override
    @Transactional(readOnly = true)
    public void assertMember(UUID userId, UUID conversationId) {
        members.findActiveMember(conversationId, userId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));
    }

    @Override
    @Transactional(readOnly = true)
    public java.util.Set<UUID> mutedMembers(UUID conversationId) {
        java.time.Instant now = java.time.Instant.now();
        return members.findActiveMembers(conversationId).stream()
                .filter(m -> m.isMuted(now))
                .map(m -> m.getId().getUserId())
                .collect(java.util.stream.Collectors.toSet());
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isMember(UUID userId, UUID conversationId) {
        return members.findActiveMember(conversationId, userId).isPresent();
    }

    @Override
    @Transactional(readOnly = true)
    public List<UUID> activeMemberIds(UUID conversationId) {
        return members.findActiveMembers(conversationId).stream()
                .map(m -> m.getId().getUserId())
                .toList();
    }
}
