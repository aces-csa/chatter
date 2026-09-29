package com.chatter.keys.web;

import com.chatter.keys.api.KeyDtos;
import com.chatter.keys.domain.KeyService;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/api/v1/keys")
public class KeyController {

    private final KeyService keyService;

    private final RateLimiter limiter;

    public KeyController(KeyService keyService, RateLimiter limiter) {
        this.keyService = keyService;
        this.limiter = limiter;
    }

    /** Called once, right after OTP verification, by the device that generated the keys. */
    @PostMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void register(@Valid @RequestBody KeyDtos.RegisterKeysRequest request) {
        keyService.register(CurrentUser.require().deviceId(), request);
    }

    @PostMapping("/top-up")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void topUp(@Valid @RequestBody KeyDtos.TopUpRequest request) {
        keyService.topUp(CurrentUser.require().deviceId(), request.oneTimePreKeys());
    }

    /** The client polls this on connect and uploads more when it drops below 20. */
    @GetMapping("/count")
    public KeyDtos.PreKeyCount count() {
        return keyService.count(CurrentUser.require().deviceId());
    }

    /**
     * Consumes a one-time prekey per returned device. Not idempotent by design: each call hands
     * out fresh key material, which is the whole point of a one-time prekey.
     */
    @GetMapping("/{userId}/bundle")
    public KeyDtos.UserBundles bundle(@PathVariable UUID userId,
                                      @RequestParam(required = false) UUID deviceId) {
        // Each fetch burns one of the target's one-time prekeys; unthrottled, anyone could drain
        // a victim's supply and strip forward secrecy from their next session setups.
        limiter.check(Limits.PREKEY_BUNDLES, CurrentUser.require().userId().toString());
        return keyService.bundlesFor(userId, deviceId);
    }
}
