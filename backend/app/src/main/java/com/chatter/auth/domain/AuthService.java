package com.chatter.auth.domain;

import com.chatter.auth.api.DeviceRevokedEvent;
import com.chatter.auth.persistence.DeviceEntity;
import com.chatter.auth.persistence.DeviceRepository;
import com.chatter.auth.persistence.RefreshTokenEntity;
import com.chatter.auth.persistence.RefreshTokenRepository;
import com.chatter.auth.web.dto.AuthTokens;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.platform.security.JwtService;
import com.chatter.user.api.UserDirectory;
import com.chatter.user.api.UserDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);
    private static final Duration REFRESH_TTL = Duration.ofDays(30);

    private final OtpService otpService;
    private final UserDirectory users;
    private final DeviceRepository devices;
    private final RefreshTokenRepository refreshTokens;
    private final JwtService jwt;
    private final ApplicationEventPublisher events;
    private final com.chatter.platform.security.RevokedDevices revokedDevices;
    private final SecureRandom random = new SecureRandom();

    public AuthService(OtpService otpService, UserDirectory users, DeviceRepository devices,
                       RefreshTokenRepository refreshTokens, JwtService jwt,
                       ApplicationEventPublisher events,
                       com.chatter.platform.security.RevokedDevices revokedDevices) {
        this.otpService = otpService;
        this.users = users;
        this.devices = devices;
        this.refreshTokens = refreshTokens;
        this.jwt = jwt;
        this.events = events;
        this.revokedDevices = revokedDevices;
    }

    public OtpService.Challenge startRegistration(String phoneE164) {
        return otpService.issue(phoneE164);
    }

    public record VerifiedSession(UserDto user, UUID deviceId, AuthTokens tokens) {
    }

    @Transactional
    public VerifiedSession verify(String otpToken, String code, String displayName,
                                  String deviceName, String platform) {
        String phone = otpService.verify(otpToken, code);
        UserDto user = users.findOrCreateByPhone(phone, displayName);

        boolean isFirstDevice = devices.findByUserId(user.id()).isEmpty();
        DeviceEntity device = devices.save(new DeviceEntity(
                Ids.next(), user.id(), deviceName, platform, isFirstDevice));

        AuthTokens tokens = issueTokens(user.id(), device.getId(), UUID.randomUUID());
        return new VerifiedSession(user, device.getId(), tokens);
    }

    /**
     * Rotating refresh. Every refresh mints a new token and revokes the presented one; presenting
     * an already-revoked token means someone replayed a stolen one, so the whole family dies.
     */
    @Transactional
    public AuthTokens refresh(String presentedToken) {
        byte[] hash = sha256(presentedToken);
        RefreshTokenEntity stored = refreshTokens.findByTokenHash(hash)
                .orElseThrow(() -> new AppException(ErrorCode.AUTH_REQUIRED, "Unknown refresh token"));

        if (stored.getRevokedAt() != null) {
            log.warn("Refresh token reuse detected for family {}; revoking the family",
                    stored.getFamilyId());
            refreshTokens.revokeFamily(stored.getFamilyId(), Instant.now());
            throw new AppException(ErrorCode.AUTH_REQUIRED,
                    "This session was revoked. Please sign in again.");
        }
        if (!stored.isUsable()) {
            throw new AppException(ErrorCode.AUTH_REQUIRED, "Refresh token expired");
        }

        DeviceEntity device = devices.findById(stored.getDeviceId())
                .orElseThrow(() -> AppException.notFound("Device"));

        stored.revoke();
        return issueTokens(device.getUserId(), device.getId(), stored.getFamilyId());
    }

    @Transactional
    public void logout(String presentedToken) {
        refreshTokens.findByTokenHash(sha256(presentedToken))
                .ifPresent(t -> refreshTokens.revokeFamily(t.getFamilyId(), Instant.now()));
    }

    /** A fresh session for a device that was just linked by QR (a new refresh-token family). */
    @Transactional
    public AuthTokens issueFor(UUID userId, UUID deviceId) {
        return issueTokens(userId, deviceId, UUID.randomUUID());
    }

    /**
     * Removes one of the account's devices: its keys, refresh tokens and push subscription go
     * with it by cascade, and other people's clients stop encrypting to it on their next send.
     */
    @Transactional
    public void revokeDevice(UUID userId, UUID deviceId) {
        DeviceEntity device = devices.findById(deviceId)
                .filter(d -> d.getUserId().equals(userId))
                .orElseThrow(() -> AppException.notFound("Device"));
        devices.delete(device);
        revokedDevices.mark(deviceId);
        events.publishEvent(new DeviceRevokedEvent(userId, deviceId));
        log.info("Device {} of user {} revoked", deviceId, userId);
    }

    private AuthTokens issueTokens(UUID userId, UUID deviceId, UUID familyId) {
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String refresh = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);

        refreshTokens.save(new RefreshTokenEntity(
                Ids.next(), deviceId, familyId, sha256(refresh), Instant.now().plus(REFRESH_TTL)));

        return new AuthTokens(
                jwt.issueAccessToken(userId, deviceId), refresh, jwt.accessTtlSeconds());
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
