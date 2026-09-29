package com.chatter.auth.web.dto;

public record AuthTokens(String accessToken, String refreshToken, long expiresInSeconds) {
}
