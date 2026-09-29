package com.chatter.platform.web;

import com.chatter.platform.security.JwtKeys;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Public halves of the signing key, so the ws-gateway validates tokens locally and never calls
 * back into auth on the hot path.
 */
@RestController
public class JwksController {

    private final JwtKeys keys;

    public JwksController(JwtKeys keys) {
        this.keys = keys;
    }

    @GetMapping("/.well-known/jwks.json")
    public Map<String, Object> jwks() {
        return keys.jwks();
    }
}
