package com.chatter.auth.domain;

import com.chatter.auth.persistence.DeviceEntity;
import com.chatter.auth.persistence.DeviceRepository;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.user.api.UserDirectory;
import com.chatter.user.api.UserDto;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

/**
 * Linking another browser to an existing account by QR code (FR-1.5, LLD step 16).
 *
 * <pre>
 *  new browser                       server (Redis, 2 min)             signed-in device
 *  start ──────────────────────────> link:{id} = PENDING
 *  shows QR "chatter-link:{id}"                                 <──── scans, sees "Chrome on Windows"
 *                                    link:{id} = APPROVED(device) <── approve
 *  claim(id, pollSecret) ──────────> tokens minted now, link deleted
 * </pre>
 *
 * <p>The QR shows only the link id. Collecting the session needs the poll secret, which never
 * leaves the new browser, so a photo of the QR is useless to anyone else. Tokens are minted at
 * claim time rather than at approval, so no usable credential ever sits in Redis.
 *
 * <p>What this does not protect against: someone tricking you into approving <em>their</em> QR.
 * That is why approval shows the requesting device's name and needs an explicit confirm.
 */
@Service
public class LinkService {

    private static final Duration LINK_TTL = Duration.ofMinutes(2);
    /** Primary plus companions; WhatsApp allows four companions, we allow a few more. */
    private static final int MAX_DEVICES = 8;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final StringRedisTemplate redis;
    private final DeviceRepository devices;
    private final UserDirectory users;
    private final AuthService auth;

    public LinkService(StringRedisTemplate redis, DeviceRepository devices, UserDirectory users,
                       AuthService auth) {
        this.redis = redis;
        this.devices = devices;
        this.users = users;
        this.auth = auth;
    }

    public record LinkStart(String linkId, String pollSecret, long expiresInSeconds) {
    }

    public record LinkPreview(String deviceName, String platform) {
    }

    /** @return null while nobody has approved yet */
    public record Claimed(AuthService.VerifiedSession session) {
    }

    public LinkStart start(String deviceName, String platform) {
        // Short enough to type from the screen when a camera is not available.
        String linkId = readableCode(10);
        String pollSecret = randomToken(32);
        redis.opsForHash().putAll(key(linkId), Map.of(
                "pollHash", hash(pollSecret),
                "deviceName", truncate(deviceName, 64),
                "platform", truncate(platform, 32),
                "state", "PENDING"));
        redis.expire(key(linkId), LINK_TTL);
        return new LinkStart(linkId, pollSecret, LINK_TTL.toSeconds());
    }

    public LinkPreview preview(String linkId) {
        Map<Object, Object> link = pending(linkId);
        return new LinkPreview((String) link.get("deviceName"), (String) link.get("platform"));
    }

    /**
     * Creates the new device on the approver's account. The first approval wins; a second device
     * racing to approve the same QR gets "already used" rather than creating a second device.
     */
    @Transactional
    public void approve(UUID userId, String linkId) {
        Map<Object, Object> link = pending(linkId);
        if (devices.findByUserId(userId).size() >= MAX_DEVICES) {
            throw new AppException(ErrorCode.VALIDATION_FAILED,
                    "You can link at most " + MAX_DEVICES + " devices. Log one out first.");
        }
        UUID deviceId = Ids.next();
        Boolean won = redis.opsForHash().putIfAbsent(key(linkId), "deviceId", deviceId.toString());
        if (!Boolean.TRUE.equals(won)) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "This code has already been used");
        }
        devices.save(new DeviceEntity(deviceId, userId, (String) link.get("deviceName"),
                (String) link.get("platform"), false));
        redis.opsForHash().putAll(key(linkId), Map.of("state", "APPROVED", "userId", userId.toString()));
    }

    /** Polled by the new browser. Returns a session exactly once, then the link is gone. */
    @Transactional
    public Claimed claim(String linkId, String pollSecret) {
        Map<Object, Object> link = redis.opsForHash().entries(key(linkId));
        if (link.isEmpty()) {
            throw new AppException(ErrorCode.NOT_FOUND, "This code expired. A new one will be shown.");
        }
        if (!MessageDigest.isEqual(hash(pollSecret).getBytes(StandardCharsets.UTF_8),
                ((String) link.get("pollHash")).getBytes(StandardCharsets.UTF_8))) {
            throw new AppException(ErrorCode.AUTH_REQUIRED, "Not your link");
        }
        if (!"APPROVED".equals(link.get("state"))) {
            return new Claimed(null);
        }
        // Delete first: whoever deletes the key is the one claimant, even if polls overlap.
        if (!Boolean.TRUE.equals(redis.delete(key(linkId)))) {
            throw new AppException(ErrorCode.NOT_FOUND, "Already claimed");
        }
        UUID userId = UUID.fromString((String) link.get("userId"));
        UUID deviceId = UUID.fromString((String) link.get("deviceId"));
        UserDto user = users.findById(userId).orElseThrow(() -> AppException.notFound("User"));
        return new Claimed(new AuthService.VerifiedSession(user, deviceId, auth.issueFor(userId, deviceId)));
    }

    private Map<Object, Object> pending(String linkId) {
        Map<Object, Object> link = redis.opsForHash().entries(key(linkId));
        if (link.isEmpty() || !"PENDING".equals(link.get("state"))) {
            throw new AppException(ErrorCode.NOT_FOUND, "This code expired or was already used");
        }
        return link;
    }

    private static String key(String linkId) {
        // Typed codes arrive in any case and with the grouping dashes the screen shows.
        return "link:" + linkId.replace("-", "").trim().toUpperCase(java.util.Locale.ROOT);
    }

    /** No 0/O, 1/I/L: this code gets read off one screen and typed into another. */
    private static final char[] READABLE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();

    private static String readableCode(int length) {
        char[] out = new char[length];
        for (int i = 0; i < length; i++) {
            out[i] = READABLE[RANDOM.nextInt(READABLE.length)];
        }
        return new String(out);
    }

    private static String randomToken(int bytes) {
        byte[] raw = new byte[bytes];
        RANDOM.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private static String hash(String value) {
        try {
            return Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String truncate(String value, int max) {
        String v = value == null || value.isBlank() ? "Web browser" : value.trim();
        return v.length() > max ? v.substring(0, max) : v;
    }
}
