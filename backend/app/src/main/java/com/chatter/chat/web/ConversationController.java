package com.chatter.chat.web;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.domain.ConversationService;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.chatter.platform.ratelimit.Limits;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/conversations")
public class ConversationController {

    private final com.chatter.chat.domain.MessageInfoService messageInfo;

    private final com.chatter.platform.ratelimit.RateLimiter limiter;

    private final ConversationService conversations;

    public ConversationController(ConversationService conversations,
                                  com.chatter.platform.ratelimit.RateLimiter limiter,
                                  com.chatter.chat.domain.MessageInfoService messageInfo) {
        this.messageInfo = messageInfo;
        this.limiter = limiter;
        this.conversations = conversations;
    }

    @GetMapping
    public List<ChatDtos.ConversationDto> list() {
        return conversations.listFor(CurrentUser.require().userId());
    }

    @PostMapping
    public ChatDtos.ConversationDto create(
            @Valid @RequestBody ChatDtos.CreateConversationRequest request) {
        UUID me = CurrentUser.require().userId();
        if ("GROUP".equalsIgnoreCase(request.type())) {
            limiter.check(Limits.GROUP_CREATE, me.toString());
        }
        return conversations.create(me, request);
    }

    @PutMapping("/{id}/state")
    public ChatDtos.ConversationDto setState(@PathVariable UUID id, @RequestBody ChatDtos.ChatStateRequest request) {
        return conversations.setState(CurrentUser.require().userId(), id, request);
    }

    /** FR-4.8: who has received and read one of your messages. Only its sender may ask. */
    @GetMapping("/{id}/messages/{messageId}/info")
    public List<ChatDtos.MessageReceipt> messageInfo(@PathVariable UUID id, @PathVariable UUID messageId) {
        return messageInfo.info(CurrentUser.require().userId(), id, messageId);
    }

    @PostMapping("/{id}/mute")
    public ChatDtos.ConversationDto mute(@PathVariable UUID id,
                                         @Valid @RequestBody ChatDtos.MuteRequest request) {
        return conversations.mute(CurrentUser.require().userId(), id, request.duration());
    }

    @PutMapping("/{id}/disappearing")
    public ChatDtos.ConversationDto setDisappearing(
            @PathVariable UUID id, @RequestBody ChatDtos.DisappearingRequest request) {
        return conversations.setDisappearing(CurrentUser.require().userId(), id, request.seconds());
    }

    @GetMapping("/{id}")
    public ChatDtos.ConversationDto get(@PathVariable UUID id) {
        return conversations.get(id, CurrentUser.require().userId());
    }
}
