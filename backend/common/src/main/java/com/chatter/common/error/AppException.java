package com.chatter.common.error;

public class AppException extends RuntimeException {

    private final ErrorCode code;

    public AppException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    public static AppException notFound(String what) {
        return new AppException(ErrorCode.NOT_FOUND, what + " not found");
    }

    public static AppException forbidden(String message) {
        return new AppException(ErrorCode.CONVERSATION_FORBIDDEN, message);
    }

    public ErrorCode code() {
        return code;
    }
}
