package com.chatter.platform.ratelimit;

import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

/**
 * Token buckets in Redis (LLD section 7), shared by every app instance. One Lua script per check,
 * so read-refill-take is atomic without locks, and Redis's own clock is the only clock -- app
 * instances with skewed clocks cannot hand out extra tokens.
 *
 * <p>Fails <em>open</em>: if Redis is down, requests are allowed and the failure is counted.
 * Rate limits protect capacity and slow abuse; they are not worth taking messaging down for,
 * and every other Redis dependency in this system already degrades rather than stops.
 */
@Component
public class RateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);

    /** Returns {allowed (0/1), milliseconds until a token is available}. */
    private static final DefaultRedisScript<List> BUCKET = new DefaultRedisScript<>("""
            local key = KEYS[1]
            local capacity = tonumber(ARGV[1])
            local per_ms = tonumber(ARGV[2])
            local t = redis.call('TIME')
            local now = t[1] * 1000 + math.floor(t[2] / 1000)
            local state = redis.call('HMGET', key, 'tokens', 'ts')
            local tokens = tonumber(state[1])
            local ts = tonumber(state[2])
            if tokens == nil then tokens = capacity; ts = now end
            tokens = math.min(capacity, tokens + (now - ts) * per_ms)
            local allowed = 0
            local wait = 0
            if tokens >= 1 then
              tokens = tokens - 1
              allowed = 1
            else
              wait = math.ceil((1 - tokens) / per_ms)
            end
            redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
            redis.call('PEXPIRE', key, math.ceil(capacity / per_ms) + 1000)
            return {allowed, wait}
            """, List.class);

    private final StringRedisTemplate redis;
    private final MeterRegistry metrics;

    public RateLimiter(StringRedisTemplate redis, MeterRegistry metrics) {
        this.redis = redis;
        this.metrics = metrics;
    }

    /**
     * @param subject who is being limited: a user id, device id, IP or phone number
     * @throws RateLimitedException when the bucket is empty
     */
    public void check(Limit limit, String subject) {
        List<?> result;
        try {
            double perMs = (double) limit.capacity() / limit.window().toMillis();
            result = redis.execute(BUCKET, List.of("rl:" + limit.scope() + ":" + subject),
                    Integer.toString(limit.capacity()), Double.toString(perMs));
        } catch (DataAccessException e) {
            metrics.counter("chatter.ratelimit.unavailable").increment();
            log.warn("Rate limiter unavailable; allowing {} for {}", limit.scope(), subject);
            return;
        }
        if (result != null && ((Number) result.get(0)).intValue() == 0) {
            metrics.counter("chatter.ratelimit.rejected", "scope", limit.scope()).increment();
            long waitMs = ((Number) result.get(1)).longValue();
            throw new RateLimitedException(limit, Math.max(1, (waitMs + 999) / 1000));
        }
    }

    /** A bucket of {@code capacity} tokens that refills completely over {@code window}. */
    public record Limit(String scope, int capacity, Duration window) {
    }
}
