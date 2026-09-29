package com.chatter.platform.error;

import com.chatter.common.error.ErrorCode;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One error shape for every REST response and every NACK/ERROR frame (LLD 5.5).
 *
 * @param traceId the request's trace id, so a user's bug report can be matched to server logs
 *                and spans without anyone reading a stack trace out to them
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiError(String code, String message, boolean retryable, String traceId) {

    public static ApiError of(ErrorCode code, String message) {
        return new ApiError(code.name(), message, code.retryable(), null);
    }

    public ApiError withTrace(String traceId) {
        return new ApiError(code, message, retryable, traceId);
    }
}
