package com.chatter.common;

import com.github.f4b6a3.uuid.UuidCreator;

import java.util.UUID;

/**
 * UUIDv7 everywhere. It is time-ordered, so it keeps B-tree indexes from fragmenting the way v4
 * does and it sorts usefully in logs.
 */
public final class Ids {

    private Ids() {
    }

    public static UUID next() {
        return UuidCreator.getTimeOrderedEpoch();
    }

    /**
     * Deterministic conversation id for a DIRECT chat, so two clients racing to open the same
     * conversation converge on one row instead of creating two (LLD 4.2).
     */
    public static UUID directConversationId(UUID a, UUID b) {
        String pairKey = pairKey(a, b);
        return UUID.nameUUIDFromBytes(pairKey.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    public static String pairKey(UUID a, UUID b) {
        return a.compareTo(b) <= 0 ? a + ":" + b : b + ":" + a;
    }
}
