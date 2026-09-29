package com.chatter.gateway.client;

import com.chatter.common.wire.Frames;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** The gateway's only way into the app. Everything stateful happens on the other side of this. */
@Component
public class ChatApiClient {

    private final RestClient client;

    public ChatApiClient(RestClient.Builder builder,
                         @Value("${chatter.app.base-url:http://localhost:8080}") String baseUrl,
                         @Value("${chatter.internal.token}") String internalToken) {
        this.client = builder
                .baseUrl(baseUrl)
                .defaultHeader("X-Internal-Token", internalToken)
                .defaultHeader("Content-Type", MediaType.APPLICATION_JSON_VALUE)
                .build();
    }

    public record IngestRequest(UUID senderId, UUID senderDeviceId, UUID clientMessageId,
                                UUID conversationId, List<Frames.RecipientPayload> payloads,
                                String groupCiphertext, Boolean silent, UUID editOf,
                                UUID deleteOf, List<UUID> mentions) {
    }

    public record IngestResult(UUID messageId, UUID clientMessageId, long seq, long createdAt,
                               boolean duplicate, Long expiresAt) {
    }

    public record ReceiptRequest(UUID userId, UUID deviceId, UUID conversationId, long uptoSeq) {
    }

    public record SyncRequest(UUID userId, UUID deviceId, Map<UUID, Long> cursors, Integer limit) {
    }

    public IngestResult send(IngestRequest request) {
        return client.post()
                .uri("/internal/v1/messages")
                .body(request)
                .retrieve()
                .body(IngestResult.class);
    }

    public void markDelivered(ReceiptRequest request) {
        client.post().uri("/internal/v1/receipts/delivered").body(request).retrieve().toBodilessEntity();
    }

    public void markRead(ReceiptRequest request) {
        client.post().uri("/internal/v1/receipts/read").body(request).retrieve().toBodilessEntity();
    }

    public record VisibilityRequest(UUID viewerId, List<UUID> userIds) {
    }

    public record VisibilityResponse(List<UUID> onlineVisible, List<UUID> lastSeenVisible) {
    }

    public record TypingRequest(UUID userId, UUID deviceId, UUID conversationId, String state) {
    }

    /** Privacy lives with the contact graph, so the app decides whose presence may be forwarded. */
    public VisibilityResponse presenceVisibility(VisibilityRequest request) {
        return client.post()
                .uri("/internal/v1/presence/visibility")
                .body(request)
                .retrieve()
                .body(VisibilityResponse.class);
    }

    public void typing(TypingRequest request) {
        client.post()
                .uri("/internal/v1/presence/typing")
                .body(request)
                .retrieve()
                .toBodilessEntity();
    }

    // --- Calls: the app owns call state; the gateway only relays ------------------------------

    public List<Frames.CallParticipant> callJoin(UUID userId, UUID deviceId, UUID conversationId, boolean video) {
        Frames.CallParticipant[] roster = client.post()
                .uri("/internal/v1/calls/join")
                .body(Map.of("userId", userId, "deviceId", deviceId, "conversationId", conversationId, "video", video))
                .retrieve()
                .body(Frames.CallParticipant[].class);
        return roster == null ? List.of() : List.of(roster);
    }

    public void callLeave(UUID userId, UUID deviceId, UUID conversationId) {
        client.post().uri("/internal/v1/calls/leave")
                .body(Map.of("userId", userId, "deviceId", deviceId, "conversationId", conversationId))
                .retrieve().toBodilessEntity();
    }

    public void callSignal(UUID userId, UUID deviceId, Frames.CallSignal signal) {
        client.post().uri("/internal/v1/calls/signal")
                .body(Map.of("userId", userId, "deviceId", deviceId, "signal", signal))
                .retrieve().toBodilessEntity();
    }

    public void callDisconnected(UUID userId, UUID deviceId) {
        client.post().uri("/internal/v1/calls/disconnected")
                .body(Map.of("userId", userId, "deviceId", deviceId))
                .retrieve().toBodilessEntity();
    }

    public Frames.SyncPage sync(SyncRequest request) {
        return client.post()
                .uri("/internal/v1/sync")
                .body(request)
                .retrieve()
                .body(Frames.SyncPage.class);
    }
}
