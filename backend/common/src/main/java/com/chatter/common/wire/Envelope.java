package com.chatter.common.wire;

import com.chatter.common.Ids;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.UUID;

/**
 * The single realtime frame shape. {@code payload} is left as a loosely typed object so the
 * gateway can relay frames it does not need to understand.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Envelope(
        int v,
        EnvelopeType type,
        UUID id,
        long ts,
        Object payload
) {
    public static final int VERSION = 1;

    public static Envelope of(EnvelopeType type, Object payload) {
        return new Envelope(VERSION, type, Ids.next(), Instant.now().toEpochMilli(), payload);
    }
}
