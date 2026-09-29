package com.chatter.platform.ratelimit;

import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;

/** Carries how long to wait, which becomes the Retry-After header (LLD 5.5). */
public class RateLimitedException extends AppException {

    private final long retryAfterSeconds;

    public RateLimitedException(RateLimiter.Limit limit, long retryAfterSeconds) {
        super(ErrorCode.RATE_LIMITED, "Too many requests (" + limit.scope() + "). Try again in "
                + retryAfterSeconds + "s.");
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
