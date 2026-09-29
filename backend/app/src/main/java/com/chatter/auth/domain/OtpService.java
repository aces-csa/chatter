package com.chatter.auth.domain;

import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Phone verification. The OTP is stored hashed with a short TTL and burned after five failed
 * attempts, so a six-digit code is not brute-forceable in the window it exists.
 */
@Service
public class OtpService {

    private static final Logger log = LoggerFactory.getLogger(OtpService.class);
    private static final Duration TTL = Duration.ofMinutes(5);
    private static final int MAX_ATTEMPTS = 5;

    private final StringRedisTemplate redis;
    private final SecureRandom random = new SecureRandom();
    private final boolean logCodes;

    public OtpService(StringRedisTemplate redis,
                      @Value("${chatter.auth.log-otp:false}") boolean logCodes) {
        this.redis = redis;
        this.logCodes = logCodes;
    }

    public record Challenge(String otpToken, long expiresInSeconds) {
    }

    public Challenge issue(String phoneE164) {
        String code = "%06d".formatted(random.nextInt(1_000_000));
        String otpToken = UUID.randomUUID().toString();

        redis.opsForValue().set(codeKey(otpToken), sha256(code + ":" + phoneE164), TTL);
        redis.opsForValue().set(phoneKey(otpToken), phoneE164, TTL);
        redis.opsForValue().set(attemptKey(otpToken), "0", TTL);

        if (logCodes) {
            // Dev only. In production the code goes to an SMS provider and never to a log.
            log.info("OTP for {} is {} (otpToken={})", phoneE164, code, otpToken);
        }
        return new Challenge(otpToken, TTL.toSeconds());
    }

    /** @return the verified phone number */
    public String verify(String otpToken, String code) {
        String expected = redis.opsForValue().get(codeKey(otpToken));
        String phone = redis.opsForValue().get(phoneKey(otpToken));
        if (expected == null || phone == null) {
            throw new AppException(ErrorCode.OTP_INVALID, "This code has expired. Request a new one.");
        }

        Long attempts = redis.opsForValue().increment(attemptKey(otpToken));
        if (attempts != null && attempts > MAX_ATTEMPTS) {
            burn(otpToken);
            throw new AppException(ErrorCode.OTP_EXHAUSTED, "Too many attempts. Request a new code.");
        }

        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                sha256(code + ":" + phone).getBytes(StandardCharsets.UTF_8))) {
            throw new AppException(ErrorCode.OTP_INVALID, "That code is not correct.");
        }

        burn(otpToken);
        return phone;
    }

    private void burn(String otpToken) {
        redis.delete(java.util.List.of(codeKey(otpToken), phoneKey(otpToken), attemptKey(otpToken)));
    }

    private static String codeKey(String t) {
        return "otp:" + t + ":code";
    }

    private static String phoneKey(String t) {
        return "otp:" + t + ":phone";
    }

    private static String attemptKey(String t) {
        return "otp:" + t + ":attempts";
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
