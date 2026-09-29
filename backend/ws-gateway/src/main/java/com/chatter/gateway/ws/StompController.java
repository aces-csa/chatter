package com.chatter.gateway.ws;

import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.gateway.client.ChatApiClient;
import com.chatter.gateway.presence.PresenceRegistry;
import com.chatter.gateway.presence.PresenceSubscriptions;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;
import org.springframework.web.client.RestClientResponseException;

import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Inbound frame handlers. Each one is deliberately thin: validate, translate, hand to the app,
 * translate the answer back. The gateway holds sockets; it does not hold rules.
 */
@Controller
public class StompController {

    private static final Logger log = LoggerFactory.getLogger(StompController.class);
    private static final String DESTINATION = "/queue/events";

    private final ChatApiClient chatApi;
    private final SimpMessagingTemplate messaging;
    private final ObjectMapper mapper;
    private final PresenceRegistry presence;
    private final PresenceSubscriptions subscriptions;

    public StompController(ChatApiClient chatApi, SimpMessagingTemplate messaging,
                           ObjectMapper mapper, PresenceRegistry presence,
                           PresenceSubscriptions subscriptions) {
        this.chatApi = chatApi;
        this.messaging = messaging;
        this.mapper = mapper;
        this.presence = presence;
        this.subscriptions = subscriptions;
    }

    @MessageMapping("/send")
    public void send(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.Send frame = mapper.convertValue(envelope.payload(), Frames.Send.class);

        try {
            ChatApiClient.IngestResult result = chatApi.send(new ChatApiClient.IngestRequest(
                    who.userId(), who.deviceId(), frame.clientMessageId(),
                    frame.conversationId(),
                    frame.payloads() == null ? List.of() : frame.payloads(),
                    frame.groupCiphertext(), frame.silent(), frame.editOf(), frame.deleteOf(),
                    frame.mentions()));

            reply(who, Envelope.of(EnvelopeType.ACK, new Frames.Ack(
                    result.clientMessageId(), result.messageId(), result.seq(),
                    result.createdAt(), result.expiresAt())));
        } catch (RestClientResponseException e) {
            // A NACK carries the error back to the specific pending message so the client can
            // show a retry affordance on that bubble rather than a generic banner.
            reply(who, Envelope.of(EnvelopeType.NACK, new Frames.Nack(
                    frame.clientMessageId(), errorCode(e), errorMessage(e),
                    e.getStatusCode().is5xxServerError() || e.getStatusCode().value() == 429)));
        }
    }

    @MessageMapping("/receipt")
    public void receipt(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.Receipt frame = mapper.convertValue(envelope.payload(), Frames.Receipt.class);
        ChatApiClient.ReceiptRequest request = new ChatApiClient.ReceiptRequest(
                who.userId(), who.deviceId(), frame.conversationId(), frame.uptoSeq());

        if (envelope.type() == EnvelopeType.READ) {
            chatApi.markRead(request);
        } else {
            chatApi.markDelivered(request);
        }
    }

    @MessageMapping("/sync")
    public void sync(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.Sync frame = mapper.convertValue(envelope.payload(), Frames.Sync.class);

        Frames.SyncPage page = chatApi.sync(new ChatApiClient.SyncRequest(
                who.userId(), who.deviceId(), frame.cursors(), frame.limit()));

        reply(who, Envelope.of(EnvelopeType.SYNC_PAGE, page));
    }

    /**
     * Typing goes through the app because it must reach the conversation's members, and
     * membership is the app's data. Failures are swallowed deliberately: a dropped typing
     * indicator is not worth an error frame, and the 5s TTL cleans up after itself.
     */
    @MessageMapping("/typing")
    public void typing(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.Typing frame = mapper.convertValue(envelope.payload(), Frames.Typing.class);
        try {
            chatApi.typing(new ChatApiClient.TypingRequest(
                    who.userId(), who.deviceId(), frame.conversationId(), frame.state()));
        } catch (Exception e) {
            log.debug("Typing frame dropped for {}", who.deviceId(), e);
        }
    }

    /**
     * Scopes which users' presence this device hears about, and answers immediately with the
     * current state so a freshly opened chat does not sit blank until the peer's next transition.
     */
    @MessageMapping("/presence/subscribe")
    public void presenceSubscribe(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.PresenceSub frame = mapper.convertValue(envelope.payload(), Frames.PresenceSub.class);
        List<UUID> requested = frame.userIds() == null ? List.of() : frame.userIds();

        ChatApiClient.VisibilityResponse allowed;
        try {
            allowed = chatApi.presenceVisibility(
                    new ChatApiClient.VisibilityRequest(who.userId(), requested));
        } catch (Exception e) {
            // Fail closed. Leaking presence we could not verify permission for is worse than
            // showing none at all.
            log.warn("Presence visibility lookup failed for {}; subscribing to nothing",
                    who.userId(), e);
            return;
        }

        Set<UUID> visible = Set.copyOf(allowed.onlineVisible());
        Set<UUID> lastSeenAllowed = Set.copyOf(allowed.lastSeenVisible());
        subscriptions.watch(who.deviceId(), visible);

        presence.snapshot(visible).forEach((userId, state) ->
                reply(who, Envelope.of(EnvelopeType.PRESENCE, new Frames.Presence(
                        userId,
                        state.status(),
                        lastSeenAllowed.contains(userId) ? state.lastSeenAt() : null))));
    }

    // --- Calls ------------------------------------------------------------------------------------

    /** Join or heartbeat. The reply is the roster, or REJECTED with the reason. */
    @MessageMapping("/call/join")
    public void callJoin(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.CallJoin frame = mapper.convertValue(envelope.payload(), Frames.CallJoin.class);
        try {
            List<Frames.CallParticipant> roster =
                    chatApi.callJoin(who.userId(), who.deviceId(), frame.conversationId(), frame.video());
            reply(who, Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("ROSTER",
                    frame.conversationId(), null, null, null, null, roster, null)));
        } catch (RestClientResponseException e) {
            reply(who, Envelope.of(EnvelopeType.CALL_EVENT, new Frames.CallEvent("REJECTED",
                    frame.conversationId(), null, null, null, null, null, errorMessage(e))));
        }
    }

    @MessageMapping("/call/leave")
    public void callLeave(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.CallLeave frame = mapper.convertValue(envelope.payload(), Frames.CallLeave.class);
        try {
            chatApi.callLeave(who.userId(), who.deviceId(), frame.conversationId());
        } catch (Exception e) {
            log.debug("Call leave failed for {}", who.deviceId(), e);
        }
    }

    /**
     * Signals are latency-critical and individually unimportant (ICE has many candidates and
     * retries), so a failed relay is logged, not surfaced.
     */
    @MessageMapping("/call/signal")
    public void callSignal(@Payload Envelope envelope, Principal principal) {
        SocketPrincipal who = (SocketPrincipal) principal;
        Frames.CallSignal frame = mapper.convertValue(envelope.payload(), Frames.CallSignal.class);
        try {
            chatApi.callSignal(who.userId(), who.deviceId(), frame);
        } catch (Exception e) {
            log.debug("Call signal from {} dropped", who.deviceId(), e);
        }
    }

    private void reply(SocketPrincipal who, Envelope envelope) {
        messaging.convertAndSendToUser(who.deviceId().toString(), DESTINATION, envelope);
    }

    private String errorCode(RestClientResponseException e) {
        try {
            Map<?, ?> body = mapper.readValue(e.getResponseBodyAsString(), Map.class);
            Object code = body.get("code");
            return code == null ? "INTERNAL" : code.toString();
        } catch (Exception ignored) {
            return "INTERNAL";
        }
    }

    private String errorMessage(RestClientResponseException e) {
        try {
            Map<?, ?> body = mapper.readValue(e.getResponseBodyAsString(), Map.class);
            Object message = body.get("message");
            return message == null ? "Send failed" : message.toString();
        } catch (Exception ignored) {
            return "Send failed";
        }
    }
}
