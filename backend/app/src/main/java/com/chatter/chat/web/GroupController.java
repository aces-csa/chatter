package com.chatter.chat.web;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.domain.GroupService;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** Group management (LLD 5.4). Authorization lives in GroupService, not here. */
@RestController
@RequestMapping("/api/v1")
public class GroupController {

    private final GroupService groups;

    private final RateLimiter limiter;

    public GroupController(GroupService groups, RateLimiter limiter) {
        this.groups = groups;
        this.limiter = limiter;
    }

    @PatchMapping("/conversations/{id}")
    public ChatDtos.ConversationDto update(@PathVariable UUID id,
                                           @Valid @RequestBody ChatDtos.UpdateGroupRequest request) {
        return groups.update(me(), id, request);
    }

    @PostMapping("/conversations/{id}/members")
    public ChatDtos.ConversationDto addMembers(@PathVariable UUID id,
                                               @Valid @RequestBody ChatDtos.AddMembersRequest request) {
        return groups.addMembers(me(), id, request.userIds());
    }

    @DeleteMapping("/conversations/{id}/members/{userId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeMember(@PathVariable UUID id, @PathVariable UUID userId) {
        groups.removeMember(me(), id, userId);
    }

    @PutMapping("/conversations/{id}/members/{userId}/role")
    public ChatDtos.ConversationDto setRole(@PathVariable UUID id, @PathVariable UUID userId,
                                            @Valid @RequestBody ChatDtos.RoleRequest request) {
        return groups.setRole(me(), id, userId, request.role());
    }

    @PostMapping("/conversations/{id}/leave")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void leave(@PathVariable UUID id) {
        groups.leave(me(), id);
    }

    @PostMapping("/conversations/{id}/invite")
    public ChatDtos.InviteDto invite(@PathVariable UUID id,
                                     @RequestBody(required = false) ChatDtos.CreateInviteRequest request) {
        return groups.invite(me(), id, request == null ? null : request.expiresInHours());
    }

    @DeleteMapping("/conversations/{id}/invite")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revokeInvite(@PathVariable UUID id) {
        groups.revokeInvites(me(), id);
    }

    @GetMapping("/invites/{code}")
    public ChatDtos.InvitePreviewDto preview(@PathVariable String code) {
        limiter.check(Limits.INVITE_LOOKUP, me().toString());
        return groups.preview(me(), code);
    }

    @PostMapping("/invites/{code}/join")
    public ChatDtos.ConversationDto join(@PathVariable String code) {
        limiter.check(Limits.INVITE_LOOKUP, me().toString());
        return groups.joinViaInvite(me(), code);
    }

    private static UUID me() {
        return CurrentUser.require().userId();
    }
}
