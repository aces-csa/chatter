package com.chatter.user.domain;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/**
 * Contact discovery hashes phone numbers with a server-side pepper.
 *
 * <p>Full privacy here is impossible: the E.164 space is small enough to enumerate, so a pepper
 * raises the cost of an offline attack but does not prevent a determined online one. The real
 * defence is the rate limit on the sync endpoint. We say this out loud rather than implying the
 * hash makes it safe.
 */
@Component
public class PhoneHasher {

    private final byte[] pepper;

    public PhoneHasher(@Value("${chatter.contacts.pepper}") String pepper) {
        this.pepper = pepper.getBytes(StandardCharsets.UTF_8);
    }

    public byte[] hash(String phoneE164) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(pepper);
            digest.update(phoneE164.getBytes(StandardCharsets.UTF_8));
            // Truncated to 16 bytes: enough to make collisions negligible at 10M users,
            // half the index size of the full digest.
            return Arrays.copyOf(digest.digest(), 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
