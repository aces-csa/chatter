package com.chatter.presence.web;

import com.chatter.presence.api.PresenceDtos;
import com.chatter.presence.domain.PresenceVisibilityService;
import com.chatter.presence.domain.TypingService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Called by the ws-gateway. Guarded by the shared internal token. */
@RestController
@RequestMapping("/internal/v1/presence")
public class InternalPresenceController {

    private final PresenceVisibilityService visibility;
    private final TypingService typing;

    public InternalPresenceController(PresenceVisibilityService visibility, TypingService typing) {
        this.visibility = visibility;
        this.typing = typing;
    }

    @PostMapping("/visibility")
    public PresenceDtos.VisibilityResponse visibility(
            @Valid @RequestBody PresenceDtos.VisibilityRequest request) {
        return visibility.resolve(request.viewerId(), request.userIds());
    }

    @PostMapping("/typing")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void typing(@Valid @RequestBody PresenceDtos.TypingRequest request) {
        typing.handle(request);
    }
}
