package com.chatter.platform.error;

import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private final org.springframework.beans.factory.ObjectProvider<io.micrometer.tracing.Tracer> tracer;

    public GlobalExceptionHandler(org.springframework.beans.factory.ObjectProvider<io.micrometer.tracing.Tracer> tracer) {
        this.tracer = tracer;
    }

    private ApiError traced(ApiError error) {
        io.micrometer.tracing.Tracer t = tracer.getIfAvailable();
        io.micrometer.tracing.Span span = t == null ? null : t.currentSpan();
        return span == null ? error : error.withTrace(span.context().traceId());
    }

    @ExceptionHandler(com.chatter.platform.ratelimit.RateLimitedException.class)
    ResponseEntity<ApiError> handleRateLimited(com.chatter.platform.ratelimit.RateLimitedException e) {
        return ResponseEntity.status(429)
                .header("Retry-After", Long.toString(e.retryAfterSeconds()))
                .body(traced(ApiError.of(e.code(), e.getMessage())));
    }

    @ExceptionHandler(AppException.class)
    ResponseEntity<ApiError> handleApp(AppException e) {
        return ResponseEntity.status(e.code().status()).body(traced(ApiError.of(e.code(), e.getMessage())));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + " " + f.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return ResponseEntity.badRequest()
                .body(ApiError.of(ErrorCode.VALIDATION_FAILED, detail));
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<ApiError> handleConstraint(ConstraintViolationException e) {
        return ResponseEntity.badRequest()
                .body(ApiError.of(ErrorCode.VALIDATION_FAILED, e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ApiError> handleUnexpected(Exception e) {
        // Log the detail, return none of it: stack traces in responses are an information leak.
        log.error("Unhandled exception", e);
        return ResponseEntity.status(500)
                .body(traced(ApiError.of(ErrorCode.INTERNAL, "Something went wrong")));
    }
}
