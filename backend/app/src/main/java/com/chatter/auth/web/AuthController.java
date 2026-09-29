package com.chatter.auth.web;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.auth.domain.AuthService;
import com.chatter.auth.domain.LinkService;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.auth.domain.OtpService;
import com.chatter.auth.web.dto.AuthDtos;
import com.chatter.auth.web.dto.AuthTokens;
import com.chatter.platform.security.CurrentUser;
import com.chatter.user.api.UserDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final DeviceDirectory devices;
    private final LinkService links;

    private final RateLimiter limiter;

    public AuthController(AuthService authService, DeviceDirectory devices, LinkService links,
                          RateLimiter limiter) {
        this.authService = authService;
        this.devices = devices;
        this.links = links;
        this.limiter = limiter;
    }

    public record VerifyResponse(UserDto user, UUID deviceId, AuthTokens tokens) {
    }

    @PostMapping("/register")
    public AuthDtos.RegisterResponse register(@Valid @RequestBody AuthDtos.RegisterRequest request) {
        // Per phone stops SMS pumping to one number; per IP stops one client walking many.
        limiter.check(Limits.OTP_PER_IP, Limits.clientIp());
        limiter.check(Limits.OTP_PER_PHONE, request.phone().replaceAll("[^0-9+]", ""));
        OtpService.Challenge challenge = authService.startRegistration(request.phone());
        return new AuthDtos.RegisterResponse(challenge.otpToken(), challenge.expiresInSeconds());
    }

    @PostMapping("/verify")
    public VerifyResponse verify(@Valid @RequestBody AuthDtos.VerifyRequest request) {
        limiter.check(Limits.VERIFY_PER_IP, Limits.clientIp());
        AuthService.VerifiedSession session = authService.verify(
                request.otpToken(), request.code(), request.displayName(),
                request.deviceName(), request.platform());
        return new VerifyResponse(session.user(), session.deviceId(), session.tokens());
    }

    @PostMapping("/refresh")
    public AuthTokens refresh(@Valid @RequestBody AuthDtos.RefreshRequest request) {
        limiter.check(Limits.REFRESH_PER_IP, Limits.clientIp());
        return authService.refresh(request.refreshToken());
    }

    @PostMapping("/logout")
    public void logout(@Valid @RequestBody AuthDtos.RefreshRequest request) {
        authService.logout(request.refreshToken());
    }

    @GetMapping("/devices")
    public List<DeviceDto> myDevices() {
        return devices.findByUser(CurrentUser.require().userId());
    }

    @DeleteMapping("/devices/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revokeDevice(@PathVariable UUID id) {
        authService.revokeDevice(CurrentUser.require().userId(), id);
    }

    // --- Linking a new browser by QR (FR-1.5). start and claim are unauthenticated: the new
    // --- browser has no session yet. Approving needs one, from a device already signed in.

    public record LinkStartRequest(@Size(max = 64) String deviceName, @Size(max = 32) String platform) {
    }

    public record LinkClaimRequest(@NotBlank String linkId, @NotBlank String pollSecret) {
    }

    /** {@code session} is null while the link is still waiting for approval. */
    public record LinkClaimResponse(String status, VerifyResponse session) {
    }

    @PostMapping("/link/start")
    public LinkService.LinkStart startLink(@Valid @RequestBody LinkStartRequest request) {
        limiter.check(Limits.LINK_START_PER_IP, Limits.clientIp());
        return links.start(request.deviceName(), request.platform());
    }

    @PostMapping("/link/claim")
    public LinkClaimResponse claimLink(@Valid @RequestBody LinkClaimRequest request) {
        limiter.check(Limits.LINK_CLAIM_PER_IP, Limits.clientIp());
        LinkService.Claimed claimed = links.claim(request.linkId(), request.pollSecret());
        if (claimed.session() == null) {
            return new LinkClaimResponse("PENDING", null);
        }
        AuthService.VerifiedSession s = claimed.session();
        return new LinkClaimResponse("LINKED", new VerifyResponse(s.user(), s.deviceId(), s.tokens()));
    }

    @GetMapping("/link/{linkId}")
    public LinkService.LinkPreview previewLink(@PathVariable String linkId) {
        CurrentUser.require();
        return links.preview(linkId);
    }

    @PostMapping("/link/{linkId}/approve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void approveLink(@PathVariable String linkId) {
        UUID userId = CurrentUser.require().userId();
        limiter.check(Limits.LINK_APPROVE, userId.toString());
        links.approve(userId, linkId);
    }
}
