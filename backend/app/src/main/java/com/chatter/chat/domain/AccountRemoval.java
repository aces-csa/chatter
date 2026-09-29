package com.chatter.chat.domain;

import com.chatter.chat.api.ConversationLifecycle;
import com.chatter.chat.persistence.ConversationEntity;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.chat.persistence.ConversationRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * Chat's part of deleting an account. Groups are left through the normal path, so the other
 * members see "X left", ownership is handed on, and everyone rotates their sender key. Direct
 * chats are simply left: the other person keeps their own copy of the history, as they would on
 * any messenger.
 *
 * <p>Messages the user already sent stay with their recipients until those expire normally --
 * they were delivered, and deleting someone's account does not reach into other people's chats.
 */
@Component
public class AccountRemoval implements ConversationLifecycle {

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final GroupService groups;
    private final JdbcTemplate jdbc;

    public AccountRemoval(ConversationRepository conversations, ConversationMemberRepository members,
                          GroupService groups, JdbcTemplate jdbc) {
        this.conversations = conversations;
        this.members = members;
        this.groups = groups;
        this.jdbc = jdbc;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void removeUserEverywhere(UUID userId) {
        for (ConversationMemberEntity membership : members.findMembershipsOf(userId)) {
            UUID conversationId = membership.getId().getConversationId();
            boolean group = conversations.findById(conversationId)
                    .map(ConversationEntity::isGroup)
                    .orElse(false);
            if (group) {
                groups.leave(userId, conversationId);
            } else {
                membership.leave();
            }
        }

        // The two references to users that do not cascade. The group outlives its creator.
        conversations.findByCreatedBy(userId).forEach(ConversationEntity::forgetCreator);
        members.flush();
        conversations.flush();
        jdbc.update("DELETE FROM group_invites WHERE created_by = ?", userId);

        // The mailbox: ciphertext queued for this user's devices that will now never be fetched.
        jdbc.update("DELETE FROM message_payloads WHERE recipient_user_id = ?", userId);
        jdbc.update("DELETE FROM inbox WHERE user_id = ?", userId);
    }
}
