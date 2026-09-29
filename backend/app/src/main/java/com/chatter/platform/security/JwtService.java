package com.chatter.platform.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

@Service
public class JwtService {

    private final JwtKeys keys;
    private final Duration accessTtl;
    private final String issuer;

    public JwtService(JwtKeys keys,
                      @Value("${chatter.security.jwt.access-ttl:PT15M}") Duration accessTtl,
                      @Value("${chatter.security.jwt.issuer:chatter}") String issuer) {
        this.keys = keys;
        this.accessTtl = accessTtl;
        this.issuer = issuer;
    }

    /**
     * Claims are deliberately minimal: subject, device and expiry. Anything else would be state
     * we cannot revoke, because a signed token is valid until it expires whatever the database says.
     */
    public String issueAccessToken(UUID userId, UUID deviceId) {
        Instant now = Instant.now();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(userId.toString())
                .claim("did", deviceId.toString())
                .issuer(issuer)
                .jwtID(UUID.randomUUID().toString())
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plus(accessTtl)))
                .build();

        SignedJWT jwt = new SignedJWT(
                new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(keys.rsaKey().getKeyID()).build(),
                claims);
        try {
            jwt.sign(new RSASSASigner(keys.rsaKey().toRSAPrivateKey()));
        } catch (JOSEException e) {
            throw new IllegalStateException("Cannot sign access token", e);
        }
        return jwt.serialize();
    }

    public long accessTtlSeconds() {
        return accessTtl.toSeconds();
    }
}
