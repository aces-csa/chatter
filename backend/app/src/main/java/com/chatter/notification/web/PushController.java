package com.chatter.notification.web;

import com.chatter.notification.domain.PushService;
import com.chatter.notification.domain.VapidKeys;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** LLD 5.4: POST /api/v1/push/subscriptions, plus the VAPID key and unsubscribe. */
@RestController
@RequestMapping("/api/v1/push")
public class PushController {

    private final PushService push;
    private final VapidKeys vapid;

    private final RateLimiter limiter;

    public PushController(PushService push, VapidKeys vapid, RateLimiter limiter) {
        this.push = push;
        this.vapid = vapid;
        this.limiter = limiter;
    }

    /** The shape PushSubscription.toJSON() produces in the browser. */
    public record SubscriptionRequest(
            @NotBlank @Size(max = 2048) String endpoint,
            @NotNull @Valid Keys keys
    ) {
        public record Keys(@NotBlank @Size(max = 256) String p256dh, @NotBlank @Size(max = 256) String auth) {
        }
    }

    public record EndpointRequest(@NotBlank String endpoint) {
    }

    public record VapidKey(String publicKey) {
    }

    @GetMapping("/vapid-public-key")
    public VapidKey publicKey() {
        return new VapidKey(vapid.publicKeyBase64Url());
    }

    @PostMapping("/subscriptions")
    @ResponseStatus(HttpStatus.CREATED)
    public void subscribe(@Valid @RequestBody SubscriptionRequest request) {
        limiter.check(Limits.PUSH_SUBSCRIBE, CurrentUser.require().deviceId().toString());
        push.subscribe(CurrentUser.require().deviceId(), request.endpoint(),
                request.keys().p256dh(), request.keys().auth());
    }

    @DeleteMapping("/subscriptions")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unsubscribe(@Valid @RequestBody EndpointRequest request) {
        push.unsubscribe(CurrentUser.require().deviceId(), request.endpoint());
    }
}
