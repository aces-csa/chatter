package com.chatter.common.wire;

/**
 * Every realtime frame in both directions is one {@link Envelope} carrying one of these.
 * Live delivery and catch-up share the same types deliberately: one code path, no drift
 * between "what you get live" and "what you get on reconnect" (LLD 3.1).
 */
public enum EnvelopeType {
    CONNECT_OK,
    SEND,
    ACK,
    NACK,
    MESSAGE,
    DELIVERED,
    READ,
    TYPING,
    PRESENCE,
    PRESENCE_SUB,
    SYNC,
    SYNC_PAGE,
    CONV_UPDATE,
    ERROR,
    /** S to C: ring, someone joined or left, the call ended, or the roster on joining. */
    CALL_EVENT,
    /** Both directions: an encrypted WebRTC offer, answer or ICE candidate for one device. */
    CALL_SIGNAL,
    /** S to C: a sealed-sender envelope. The server does not know who sent it. */
    SEALED
}
