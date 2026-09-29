package com.chatter.chat.domain;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.persistence.ConversationEntity;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.chat.persistence.ConversationRepository;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.user.api.UserDirectory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class ConversationService {

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final UserDirectory users;
    private final GroupService groups;
    private final ConversationMapper mapper;
    private final MessageIngestService ingest;

    public ConversationService(ConversationRepository conversations,
                               ConversationMemberRepository members,
                               UserDirectory users, GroupService groups,
                               ConversationMapper mapper, MessageIngestService ingest) {
        this.conversations = conversations;
        this.members = members;
        this.users = users;
        this.groups = groups;
        this.mapper = mapper;
        this.ingest = ingest;
    }

    @Transactional
    public ChatDtos.ConversationDto create(UUID creatorId, ChatDtos.CreateConversationRequest request) {
        return "DIRECT".equalsIgnoreCase(request.type())
                ? createDirect(creatorId, soleOther(creatorId, request.participantIds()))
                : groups.create(creatorId, request.subject(), request.participantIds());
    }

    private UUID soleOther(UUID creatorId, List<UUID> participantIds) {
        List<UUID> others = participantIds.stream().filter(id -> !id.equals(creatorId)).distinct().toList();
        if (others.size() != 1) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "A direct conversation needs exactly one other participant");
        }
        return others.getFirst();
    }

    /**
     * The conversation id is derived from the participant pair, so two clients opening the same
     * chat at the same moment produce the same id and the unique index resolves the race for us
     * (LLD 4.2).
     */
    @Transactional
    public ChatDtos.ConversationDto createDirect(UUID creatorId, UUID otherId) {
        if (users.findById(otherId).isEmpty()) {
            throw AppException.notFound("User");
        }
        String pairKey = Ids.pairKey(creatorId, otherId);

        Optional<ConversationEntity> existing = conversations.findByPairKey(pairKey);
        if (existing.isPresent()) {
            return toDto(existing.get(), creatorId);
        }

        ConversationEntity created;
        try {
            created = conversations.saveAndFlush(ConversationEntity.direct(
                    Ids.directConversationId(creatorId, otherId), pairKey, creatorId));
        } catch (org.springframework.dao.DataIntegrityViolationException raced) {
            // Someone else won the race. Their row is just as good as ours would have been.
            return toDto(conversations.findByPairKey(pairKey)
                    .orElseThrow(() -> raced), creatorId);
        }

        members.save(new ConversationMemberEntity(created.getId(), creatorId, "MEMBER"));
        members.save(new ConversationMemberEntity(created.getId(), otherId, "MEMBER"));
        return toDto(created, creatorId);
    }

    private static final java.util.Set<Integer> TIMER_CHOICES = java.util.Set.of(0, 86_400, 604_800, 7_776_000);

    /**
     * Either person in a direct chat may change the timer. In a group it counts as group info,
     * so it follows the only-admins-can-edit-info setting. The change is announced in the
     * timeline, because a timer nobody noticed is how people lose messages they meant to keep.
     */
    @Transactional
    public ChatDtos.ConversationDto setDisappearing(UUID actorId, UUID conversationId, int seconds) {
        if (!TIMER_CHOICES.contains(seconds)) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "Timer must be off, 24 hours, 7 days or 90 days");
        }
        ConversationEntity conversation = conversations.findById(conversationId)
                .orElseThrow(() -> AppException.notFound("Conversation"));
        ConversationMemberEntity actor = members.findActiveMember(conversationId, actorId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));
        if (conversation.isGroup() && conversation.isOnlyAdminsCanEditInfo() && !actor.isAdmin()) {
            throw AppException.forbidden("Only admins can change this");
        }
        if (conversation.getDisappearingSeconds() != seconds) {
            conversation.setDisappearingSeconds(seconds);
            ingest.postSystemEvent(conversationId, GroupEvent.disappearing(actorId, seconds),
                    java.util.List.of());
        }
        return toDto(conversation, actorId);
    }

    /** "Always" is stored as a date far enough away that nobody will outlive it. */
    private static final java.time.Instant MUTED_FOREVER = java.time.Instant.parse("9999-12-31T00:00:00Z");

    /** Per-member, per-chat mute (FR-4.6). Muted chats still deliver; they just stay quiet. */
    @Transactional
    public ChatDtos.ConversationDto mute(UUID userId, UUID conversationId, String duration) {
        ConversationMemberEntity member = members.findActiveMember(conversationId, userId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));
        java.time.Instant now = java.time.Instant.now();
        member.mute(switch (duration) {
            case "8h" -> now.plus(java.time.Duration.ofHours(8));
            case "1w" -> now.plus(java.time.Duration.ofDays(7));
            case "always" -> MUTED_FOREVER;
            case "off" -> null;
            default -> throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "Mute for 8h, 1w or always, or off to unmute");
        });
        return toDto(conversations.findById(conversationId).orElseThrow(), userId);
    }

    private static final int MAX_PINNED = 3;

    /** Pin (at most three, FR-7.2), archive, and mark unread (FR-7.3), per member. */
    @Transactional
    public ChatDtos.ConversationDto setState(UUID userId, UUID conversationId, ChatDtos.ChatStateRequest request) {
        ConversationMemberEntity member = members.findActiveMember(conversationId, userId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));
        if (Boolean.TRUE.equals(request.pinned()) && !member.isPinned()) {
            long pinned = members.findMembershipsOf(userId).stream().filter(ConversationMemberEntity::isPinned).count();
            if (pinned >= MAX_PINNED) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "You can pin up to " + MAX_PINNED + " chats");
            }
        }
        if (request.pinned() != null) member.setPinned(request.pinned());
        if (request.archived() != null) member.setArchived(request.archived());
        if (request.markedUnread() != null) member.setMarkedUnread(request.markedUnread());
        return toDto(conversations.findById(conversationId).orElseThrow(), userId);
    }

    @Transactional(readOnly = true)
    public List<ChatDtos.ConversationDto> listFor(UUID userId) {
        List<ConversationEntity> found = conversations.findForUser(userId);
        List<ChatDtos.ConversationDto> result = new ArrayList<>(found.size());
        for (ConversationEntity conversation : found) {
            result.add(toDto(conversation, userId));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public ChatDtos.ConversationDto get(UUID conversationId, UUID viewerId) {
        ConversationEntity conversation = conversations.findById(conversationId)
                .orElseThrow(() -> AppException.notFound("Conversation"));
        members.findActiveMember(conversationId, viewerId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this conversation"));
        return toDto(conversation, viewerId);
    }

    private ChatDtos.ConversationDto toDto(ConversationEntity conversation, UUID viewerId) {
        return mapper.toDto(conversation, viewerId);
    }
}
