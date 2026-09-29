package com.chatter.platform.security;

import com.chatter.common.security.Revocation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Makes revocation immediate. Deleting a device kills its refresh token, but an access token
 * already issued stays cryptographically valid for up to 15 minutes; this denylist is what the
 * REST filter and the gateway check so that token stops working now.
 */
@Component
public class RevokedDevices {

    private static final Logger log = LoggerFactory.getLogger(RevokedDevices.class);

    private final StringRedisTemplate redis;

    public RevokedDevices(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public void mark(UUID deviceId) {
        redis.opsForValue().set(Revocation.deviceKey(deviceId), "1", Revocation.TTL);
    }

    /**
     * Fails open: with Redis down, a revoked device keeps working until its token expires --
     * the pre-denylist behaviour -- rather than every device being locked out.
     */
    public boolean isRevoked(UUID deviceId) {
        try {
            return Boolean.TRUE.equals(redis.hasKey(Revocation.deviceKey(deviceId)));
        } catch (DataAccessException e) {
            log.warn("Revocation check unavailable; allowing device {}", deviceId);
            return false;
        }
    }
}
