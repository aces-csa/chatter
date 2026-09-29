package com.chatter.auth.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public final class AuthDtos {

    private AuthDtos() {
    }

    public record RegisterRequest(
            @NotBlank
            @Pattern(regexp = "^\\+[1-9]\\d{7,14}$", message = "must be an E.164 phone number")
            String phone
    ) {
    }

    public record RegisterResponse(String otpToken, long expiresInSeconds) {
    }

    public record VerifyRequest(
            @NotBlank String otpToken,
            @NotBlank @Pattern(regexp = "^\\d{6}$", message = "must be 6 digits") String code,
            @Size(max = 64) String displayName,
            @Size(max = 64) String deviceName,
            @Size(max = 32) String platform
    ) {
    }

    public record RefreshRequest(@NotBlank String refreshToken) {
    }
}
