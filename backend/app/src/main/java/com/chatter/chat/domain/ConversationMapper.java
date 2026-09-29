package com.chatter.chat.domain;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.persistence.ConversationEntity;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

/** One place that decides what a viewer sees of a conversation. */
@Component
public class ConversationMapper {

    private final ConversationMemberRepository members;

    public ConversationMapper(ConversationMemberRepository members) {
        this.members = members;
    }

    public ChatDtos.ConversationDto toDto(ConversationEntity conversation, UUID viewerId) {
        List<ConversationMemberEntity> active = members.findActiveMembers(conversation.getId());
        ConversationMemberEntity self = active.stream()
                .filter(m -> m.getId().getUserId().equals(viewerId))
                .findFirst()
                .orElse(null);

        return new ChatDtos.ConversationDto(
                conversation.getId(),
                conversation.getType(),
                conversation.getSubject(),
                conversation.getDescription(),
                conversation.getAvatarMediaId(),
                active.stream().map(m -> m.getId().getUserId()).toList(),
                active.stream()
                        .map(m -> new ChatDtos.MemberDto(m.getId().getUserId(), m.getRole()))
                        .toList(),
                conversation.isOnlyAdminsCanPost(),
                conversation.isOnlyAdminsCanEditInfo(),
                conversation.getDisappearingSeconds(),
                conversation.getLastSeq(),
                conversation.getLastMessageAt(),
                self == null ? 0 : self.getLastReadSeq(),
                self == null ? 0 : self.getUnreadCount(),
                self != null && self.isPinned(),
                self != null && self.isArchived(),
                self != null && self.isMuted(java.time.Instant.now()) ? self.getMutedUntil() : null,
                self != null && self.isMarkedUnread());
    }
}
