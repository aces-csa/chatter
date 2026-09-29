package com.chatter.gateway.ws;

import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.gateway.presence.PresenceRegistry;
import com.chatter.gateway.presence.PresenceSubscriptions;
import com.chatter.gateway.routing.RouteRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionSubscribeEvent;

import java.security.Principal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Component
public class SessionLifecycleListener {

    private static final Logger log = LoggerFactory.getLogger(SessionLifecycleListener.class);
    private static final String EVENTS_DESTINATION = "/user/queue/events";

    private final SocketRegistry sockets;
    private final RouteRegistry routes;
    private final SimpMessagingTemplate messaging;
    private final PresenceRegistry presence;
    private final PresenceSubscriptions subscriptions;
    private final com.chatter.gateway.client.ChatApiClient chatApi;

    public SessionLifecycleListener(SocketRegistry sockets, RouteRegistry routes,
                                    SimpMessagingTemplate messaging, PresenceRegistry presence,
                                    PresenceSubscriptions subscriptions,
                                    com.chatter.gateway.client.ChatApiClient chatApi) {
        this.sockets = sockets;
        this.routes = routes;
        this.messaging = messaging;
        this.presence = presence;
        this.subscriptions = subscriptions;
        this.chatApi = chatApi;
    }

    /**
     * Registration and CONNECT_OK happen on SUBSCRIBE, not on CONNECT.
     *
     * <p>A STOMP session is "connected" before the client has sent its SUBSCRIBE frame, and
     * anything sent to a user destination in that window is silently dropped -- there is nothing
     * subscribed to receive it. Waiting for the subscription is what makes the socket actually
     * reachable, so it is also the right moment to publish the route.
     */
    @EventListener
    public void onSubscribe(SessionSubscribeEvent event) {
        SocketPrincipal who = principal(event.getUser());
        if (who == null) {
            return;
        }
        StompHeaderAccessor accessor = StompHeaderAccessor.wrap(event.getMessage());
        if (!EVENTS_DESTINATION.equals(accessor.getDestination())) {
            return;
        }

        sockets.add(who.userId(), who.deviceId());
        routes.register(who.userId(), who.deviceId());
        presence.markOnline(who.userId(), who.deviceId());

        messaging.convertAndSendToUser(who.deviceId().toString(), "/queue/events",
                Envelope.of(EnvelopeType.CONNECT_OK, new Frames.ConnectOk(
                        who.userId(), who.deviceId(), Instant.now().toEpochMilli())));

        log.info("Device {} is live on {} ({} sockets on this node)",
                who.deviceId(), routes.gatewayId(), sockets.size());
    }

    @EventListener
    public void onDisconnect(SessionDisconnectEvent event) {
        SocketPrincipal who = principal(event.getUser());
        if (who == null) {
            return;
        }
        sockets.remove(who.deviceId());
        routes.unregister(who.userId(), who.deviceId());
        subscriptions.clear(who.deviceId());
        presence.markOffline(who.userId(), who.deviceId());
        // A closed tab must not leave a ghost in a call; the others are told it left.
        try {
            chatApi.callDisconnected(who.userId(), who.deviceId());
        } catch (Exception e) {
            log.debug("Call cleanup for {} failed; the heartbeat timeout will drop it", who.deviceId(), e);
        }
        log.info("Device {} disconnected ({} sockets remain)", who.deviceId(), sockets.size());
    }

    /**
     * Refreshes the Redis TTLs for every socket we still hold -- both the routing entry and the
     * presence entry. Without this a long-lived quiet connection would silently fall out of the
     * routing table and start missing messages, while also appearing offline.
     *
     * <p>Runs at half the TTL so a single missed tick is harmless.
     */
    @Scheduled(fixedDelay = 20_000)
    public void refreshRegistrations() {
        for (Map.Entry<UUID, UUID> entry : sockets.snapshot().entrySet()) {
            UUID deviceId = entry.getKey();
            UUID userId = entry.getValue();
            routes.refresh(userId, deviceId);
            presence.refresh(userId, deviceId);
        }
    }

    private static SocketPrincipal principal(Principal principal) {
        return principal instanceof SocketPrincipal socketPrincipal ? socketPrincipal : null;
    }
}
