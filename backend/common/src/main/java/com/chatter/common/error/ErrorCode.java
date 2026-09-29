package com.chatter.common.error;

/**
 * One error vocabulary for REST responses and for NACK/ERROR frames, so a client has exactly one
 * mapping to write (LLD 5.5).
 */
public enum ErrorCode {
    VALIDATION_FAILED(400, false),
    AUTH_REQUIRED(401, false),
    AUTH_EXPIRED(401, true),
    OTP_INVALID(400, false),
    OTP_EXHAUSTED(429, false),
    CONVERSATION_FORBIDDEN(403, false),
    USER_BLOCKED(403, false),
    NOT_FOUND(404, false),
    KEYS_NOT_REGISTERED(409, false),
    NO_PREKEYS_AVAILABLE(409, true),
    RATE_LIMITED(429, true),
    STORE_UNAVAILABLE(503, true),
    INTERNAL(500, true);

    private final int status;
    private final boolean retryable;

    ErrorCode(int status, boolean retryable) {
        this.status = status;
        this.retryable = retryable;
    }

    public int status() {
        return status;
    }

    public boolean retryable() {
        return retryable;
    }
}
