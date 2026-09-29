package com.chatter.platform.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Guards the service-to-service surface the ws-gateway calls. A shared secret is adequate because
 * this endpoint is never exposed outside the cluster network; mTLS is the production upgrade.
 *
 * <p>Deliberately <em>not</em> a {@code @Component}: Spring Boot auto-registers every Filter bean
 * into the main servlet chain, which would apply this to every request in the application rather
 * than only to /internal/**. It is constructed by {@link SecurityConfig} instead.
 */
public class InternalTokenFilter extends OncePerRequestFilter {

    static final String HEADER = "X-Internal-Token";

    private final byte[] expected;

    public InternalTokenFilter(String token) {
        this.expected = token.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String presented = request.getHeader(HEADER);
        // Constant-time compare: a timing oracle on a shared secret is a real, cheap attack.
        if (presented == null
                || !MessageDigest.isEqual(presented.getBytes(StandardCharsets.UTF_8), expected)) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"code\":\"AUTH_REQUIRED\",\"message\":\"Invalid internal token\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
