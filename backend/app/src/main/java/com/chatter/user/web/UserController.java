package com.chatter.user.web;

import com.chatter.common.error.AppException;
import com.chatter.platform.security.CurrentUser;
import com.chatter.user.api.UserDirectory;
import com.chatter.user.api.UserDto;
import com.chatter.user.domain.PhoneHasher;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.chatter.platform.ratelimit.Limits;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1")
public class UserController {

    private final com.chatter.platform.ratelimit.RateLimiter limiter;

    private final UserDirectory users;
    private final PhoneHasher phoneHasher;
    private final com.chatter.user.domain.ProfileService profiles;

    public UserController(UserDirectory users, PhoneHasher phoneHasher,
                          com.chatter.platform.ratelimit.RateLimiter limiter,
                          com.chatter.user.domain.ProfileService profiles) {
        this.limiter = limiter;
        this.profiles = profiles;
        this.users = users;
        this.phoneHasher = phoneHasher;
    }

    /**
     * Contact discovery. The client sends phone numbers; we hash them server-side with the
     * pepper and match. Sending raw numbers rather than client-side hashes is deliberate here --
     * the client cannot know the pepper, and pretending otherwise would be security theatre.
     * The real protection is the rate limit on this endpoint.
     */
    public record ContactSyncRequest(@NotNull @Size(max = 2000) List<String> phones) {
    }

    @GetMapping("/me")
    public UserDto me() {
        UUID userId = CurrentUser.require().userId();
        return users.findById(userId).orElseThrow(() -> AppException.notFound("User"));
    }

    @GetMapping("/users/{id}")
    public UserDto byId(@PathVariable UUID id) {
        UUID viewer = CurrentUser.require().userId();
        return profiles.visibleTo(viewer, users.findById(id).orElseThrow(() -> AppException.notFound("User")));
    }

    /** FR-1.4. Null fields are left unchanged; {@code removeAvatar} clears the photo. */
    public record ProfileUpdate(String displayName, String about, String avatar, Boolean removeAvatar) {
    }

    @org.springframework.web.bind.annotation.PatchMapping("/me")
    public UserDto updateMe(@RequestBody ProfileUpdate update) {
        UUID me = CurrentUser.require().userId();
        profiles.updateProfile(me, update.displayName(), update.about(), update.avatar(),
                Boolean.TRUE.equals(update.removeAvatar()));
        return users.findById(me).orElseThrow(() -> AppException.notFound("User"));
    }

    @GetMapping("/me/privacy")
    public com.chatter.user.domain.ProfileService.Privacy privacy() {
        return profiles.privacy(CurrentUser.require().userId());
    }

    @org.springframework.web.bind.annotation.PutMapping("/me/privacy")
    public com.chatter.user.domain.ProfileService.Privacy updatePrivacy(
            @RequestBody com.chatter.user.domain.ProfileService.Privacy privacy) {
        return profiles.updatePrivacy(CurrentUser.require().userId(), privacy);
    }

    /**
     * FR-2.2. A blocked person's messages to you are accepted and ticked once but never
     * delivered, they stop seeing your presence, photo and about, and their calls do not ring --
     * without being told they were blocked, which is the point.
     */
    @GetMapping("/blocks")
    public List<UUID> blocks() {
        return profiles.blockedBy(CurrentUser.require().userId());
    }

    @PostMapping("/blocks/{userId}")
    @org.springframework.web.bind.annotation.ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void block(@PathVariable UUID userId) {
        profiles.block(CurrentUser.require().userId(), userId);
    }

    @org.springframework.web.bind.annotation.DeleteMapping("/blocks/{userId}")
    @org.springframework.web.bind.annotation.ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void unblock(@PathVariable UUID userId) {
        profiles.unblock(CurrentUser.require().userId(), userId);
    }

    @PostMapping("/contacts/sync")
    public List<UserDto> sync(@Valid @RequestBody ContactSyncRequest request) {
        UUID me = CurrentUser.require().userId();
        // The phone-number space is small enough to enumerate; this limit is the real defence.
        limiter.check(Limits.CONTACT_SYNC, me.toString());
        List<byte[]> hashes = request.phones().stream().map(phoneHasher::hash).toList();
        List<UserDto> found = users.findByPhoneHashes(hashes).stream()
                .filter(u -> !u.id().equals(me))
                .toList();
        profiles.rememberContacts(me, found.stream().map(UserDto::id).toList());
        return found.stream().map(u -> profiles.visibleTo(me, u)).toList();
    }
}
