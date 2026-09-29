package com.chatter.chat.domain;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.persistence.ConversationEntity;
import com.chatter.chat.persistence.ConversationMemberEntity;
import com.chatter.chat.persistence.ConversationMemberRepository;
import com.chatter.chat.persistence.ConversationRepository;
import com.chatter.chat.persistence.GroupInviteEntity;
import com.chatter.chat.persistence.GroupInviteRepository;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.user.api.UserDirectory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;

/**
 * Group lifecycle: creation, membership, roles, settings and invite links (FR-4).
 *
 * <p>Every change is recorded as a {@link GroupEvent} in the timeline, in the same transaction as
 * the change itself. Clients react to those events -- refreshing the member list, rotating their
 * sender key when someone leaves -- so the events are load-bearing, not decoration.
 */
@Service
public class GroupService {

    public static final int MAX_MEMBERS = 1024;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final GroupInviteRepository invites;
    private final UserDirectory users;
    private final MessageIngestService ingest;
    private final ConversationMapper mapper;

    public GroupService(ConversationRepository conversations, ConversationMemberRepository members,
                        GroupInviteRepository invites, UserDirectory users,
                        MessageIngestService ingest, ConversationMapper mapper) {
        this.conversations = conversations;
        this.members = members;
        this.invites = invites;
        this.users = users;
        this.ingest = ingest;
        this.mapper = mapper;
    }

    @Transactional
    public ChatDtos.ConversationDto create(UUID creatorId, String subject, List<UUID> participantIds) {
        if (subject == null || subject.isBlank()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "A group needs a subject");
        }
        LinkedHashSet<UUID> others = new LinkedHashSet<>(participantIds);
        others.remove(creatorId);
        if (others.isEmpty()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Add at least one other person");
        }
        if (others.size() + 1 > MAX_MEMBERS) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "A group can have at most " + MAX_MEMBERS + " members");
        }
        assertUsersExist(List.copyOf(others));

        ConversationEntity group = conversations.save(
                ConversationEntity.group(Ids.next(), subject.trim(), creatorId));
        members.save(new ConversationMemberEntity(group.getId(), creatorId, "OWNER"));
        for (UUID participant : others) {
            members.save(new ConversationMemberEntity(group.getId(), participant, "MEMBER"));
        }
        members.flush();

        ingest.postSystemEvent(group.getId(), new GroupEvent("CREATED", creatorId,
                List.copyOf(others), group.getSubject(), null, null, null, null), List.of());
        return mapper.toDto(group, creatorId);
    }

    @Transactional
    public ChatDtos.ConversationDto addMembers(UUID actorId, UUID conversationId, List<UUID> userIds) {
        ConversationEntity group = group(conversationId);
        requireAdmin(actorId, conversationId);

        List<UUID> added = new ArrayList<>();
        for (UUID userId : new LinkedHashSet<>(userIds)) {
            boolean alreadyIn = members.findActiveMember(conversationId, userId).isPresent();
            if (!alreadyIn) {
                added.add(userId);
            }
        }
        if (added.isEmpty()) {
            return mapper.toDto(group, actorId);
        }
        assertUsersExist(added);
        if (members.findActiveMembers(conversationId).size() + added.size() > MAX_MEMBERS) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "A group can have at most " + MAX_MEMBERS + " members");
        }

        for (UUID userId : added) {
            join(conversationId, userId);
        }
        members.flush();
        ingest.postSystemEvent(conversationId, GroupEvent.of("MEMBERS_ADDED", actorId, added), List.of());
        return mapper.toDto(group, actorId);
    }

    /**
     * Admins can remove anyone but the owner. The removed member is told through the same event
     * everyone else gets; otherwise their client would keep a group it can no longer post to.
     */
    @Transactional
    public void removeMember(UUID actorId, UUID conversationId, UUID userId) {
        if (actorId.equals(userId)) {
            leave(actorId, conversationId);
            return;
        }
        group(conversationId);
        requireAdmin(actorId, conversationId);
        ConversationMemberEntity target = activeMember(conversationId, userId);
        if (target.isOwner()) {
            throw AppException.forbidden("The group owner cannot be removed");
        }
        target.leave();
        members.flush();
        ingest.postSystemEvent(conversationId,
                GroupEvent.of("MEMBER_REMOVED", actorId, List.of(userId)), List.of(userId));
    }

    /**
     * An owner who leaves hands the group on -- to the longest-serving admin, else the
     * longest-serving member -- so a group never ends up with nobody able to manage it.
     */
    @Transactional
    public void leave(UUID userId, UUID conversationId) {
        group(conversationId);
        ConversationMemberEntity self = activeMember(conversationId, userId);
        boolean wasOwner = self.isOwner();
        self.leave();
        members.flush();

        if (wasOwner) {
            members.findActiveMembers(conversationId).stream()
                    .min(Comparator.comparing((ConversationMemberEntity m) -> !m.isAdmin())
                            .thenComparing(ConversationMemberEntity::getJoinedAt))
                    .ifPresent(successor -> successor.changeRole("OWNER"));
            members.flush();
        }
        ingest.postSystemEvent(conversationId,
                GroupEvent.of("MEMBER_LEFT", userId, List.of(userId)), List.of(userId));
    }

    @Transactional
    public ChatDtos.ConversationDto setRole(UUID actorId, UUID conversationId, UUID userId, String role) {
        ConversationEntity group = group(conversationId);
        requireAdmin(actorId, conversationId);
        if (!"ADMIN".equals(role) && !"MEMBER".equals(role)) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Role must be ADMIN or MEMBER");
        }
        ConversationMemberEntity target = activeMember(conversationId, userId);
        if (target.isOwner()) {
            throw AppException.forbidden("The owner's role cannot be changed");
        }
        if (!role.equals(target.getRole())) {
            target.changeRole(role);
            members.flush();
            ingest.postSystemEvent(conversationId, new GroupEvent("ROLE_CHANGED", actorId,
                    List.of(userId), null, null, role, null, null), List.of());
        }
        return mapper.toDto(group, actorId);
    }

    @Transactional
    public ChatDtos.ConversationDto update(UUID actorId, UUID conversationId,
                                           ChatDtos.UpdateGroupRequest request) {
        ConversationEntity group = group(conversationId);
        ConversationMemberEntity actor = activeMember(conversationId, actorId);

        boolean editsInfo = request.subject() != null || request.description() != null;
        boolean editsSettings = request.onlyAdminsCanPost() != null
                || request.onlyAdminsCanEditInfo() != null;
        if ((editsSettings || (editsInfo && group.isOnlyAdminsCanEditInfo())) && !actor.isAdmin()) {
            throw AppException.forbidden("Only admins can change this");
        }

        if (request.subject() != null && !request.subject().trim().equals(group.getSubject())) {
            if (request.subject().isBlank()) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "A group needs a subject");
            }
            group.rename(request.subject().trim());
            ingest.postSystemEvent(conversationId, new GroupEvent("SUBJECT_CHANGED", actorId,
                    null, group.getSubject(), null, null, null, null), List.of());
        }
        if (request.description() != null
                && !request.description().equals(group.getDescription())) {
            group.describe(request.description());
            ingest.postSystemEvent(conversationId, new GroupEvent("DESCRIPTION_CHANGED", actorId,
                    null, null, request.description(), null, null, null), List.of());
        }
        if (editsSettings) {
            boolean post = request.onlyAdminsCanPost() != null
                    ? request.onlyAdminsCanPost() : group.isOnlyAdminsCanPost();
            boolean info = request.onlyAdminsCanEditInfo() != null
                    ? request.onlyAdminsCanEditInfo() : group.isOnlyAdminsCanEditInfo();
            if (post != group.isOnlyAdminsCanPost() || info != group.isOnlyAdminsCanEditInfo()) {
                group.configure(post, info);
                ingest.postSystemEvent(conversationId, new GroupEvent("SETTINGS_CHANGED", actorId,
                        null, null, null, null, post, info), List.of());
            }
        }
        return mapper.toDto(group, actorId);
    }

    /** Returns the group's live link, creating one if there is none. One link per group. */
    @Transactional
    public ChatDtos.InviteDto invite(UUID actorId, UUID conversationId, Integer expiresInHours) {
        group(conversationId);
        requireAdmin(actorId, conversationId);
        Instant now = Instant.now();
        for (GroupInviteEntity existing : invites.findUnrevoked(conversationId)) {
            if (existing.isUsable(now)) {
                return new ChatDtos.InviteDto(existing.getCode(), existing.getExpiresAt());
            }
        }
        Instant expiresAt = expiresInHours == null || expiresInHours <= 0
                ? null : now.plus(Duration.ofHours(Math.min(expiresInHours, 24 * 30)));
        GroupInviteEntity created = invites.save(
                new GroupInviteEntity(newCode(), conversationId, actorId, expiresAt));
        return new ChatDtos.InviteDto(created.getCode(), created.getExpiresAt());
    }

    /** Kills every outstanding link; the next {@link #invite} call mints a fresh one. */
    @Transactional
    public void revokeInvites(UUID actorId, UUID conversationId) {
        group(conversationId);
        requireAdmin(actorId, conversationId);
        invites.findUnrevoked(conversationId).forEach(GroupInviteEntity::revoke);
    }

    @Transactional(readOnly = true)
    public ChatDtos.InvitePreviewDto preview(UUID viewerId, String code) {
        GroupInviteEntity invite = usableInvite(code);
        ConversationEntity group = group(invite.getConversationId());
        List<ConversationMemberEntity> active = members.findActiveMembers(group.getId());
        return new ChatDtos.InvitePreviewDto(group.getId(), group.getSubject(),
                group.getDescription(), active.size(),
                active.stream().anyMatch(m -> m.getId().getUserId().equals(viewerId)));
    }

    @Transactional
    public ChatDtos.ConversationDto joinViaInvite(UUID userId, String code) {
        GroupInviteEntity invite = usableInvite(code);
        ConversationEntity group = group(invite.getConversationId());
        if (members.findActiveMember(group.getId(), userId).isPresent()) {
            return mapper.toDto(group, userId);
        }
        if (members.findActiveMembers(group.getId()).size() >= MAX_MEMBERS) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "This group is full");
        }
        join(group.getId(), userId);
        members.flush();
        ingest.postSystemEvent(group.getId(),
                GroupEvent.of("JOINED_VIA_INVITE", userId, List.of(userId)), List.of());
        return mapper.toDto(group, userId);
    }

    /** Re-adding someone reuses their old row, so their read position survives. */
    private void join(UUID conversationId, UUID userId) {
        members.findById(new ConversationMemberEntity.Key(conversationId, userId))
                .ifPresentOrElse(ConversationMemberEntity::rejoin,
                        () -> members.save(new ConversationMemberEntity(conversationId, userId, "MEMBER")));
    }

    private GroupInviteEntity usableInvite(String code) {
        GroupInviteEntity invite = invites.findById(code)
                .orElseThrow(() -> AppException.notFound("Invite link"));
        if (!invite.isUsable(Instant.now())) {
            throw new AppException(ErrorCode.NOT_FOUND, "This invite link has been reset or has expired");
        }
        return invite;
    }

    private ConversationEntity group(UUID conversationId) {
        ConversationEntity conversation = conversations.findById(conversationId)
                .orElseThrow(() -> AppException.notFound("Conversation"));
        if (!conversation.isGroup()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Not a group");
        }
        return conversation;
    }

    private ConversationMemberEntity activeMember(UUID conversationId, UUID userId) {
        return members.findActiveMember(conversationId, userId)
                .orElseThrow(() -> AppException.forbidden("Not a member of this group"));
    }

    private void requireAdmin(UUID userId, UUID conversationId) {
        if (!activeMember(conversationId, userId).isAdmin()) {
            throw AppException.forbidden("Only group admins can do that");
        }
    }

    private void assertUsersExist(List<UUID> userIds) {
        if (users.findByIds(userIds).size() != new LinkedHashSet<>(userIds).size()) {
            throw AppException.notFound("User");
        }
    }

    private static String newCode() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
