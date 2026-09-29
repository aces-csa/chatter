package com.chatter.gateway.presence;

import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.gateway.ws.SocketRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Presence changes go to <em>every</em> gateway on one shared channel, and each node forwards
 * only to its own watchers.
 *
 * <p>A broadcast is affordable here in a way it is not for messages: presence changes are rare
 * compared to message volume, and the alternative -- a routing table mapping watchers to nodes --
 * would need maintaining on every subscription change for no real saving.
 */
@Component
public class PresenceBroadcastListener implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(PresenceBroadcastListener.class);

    private final PresenceSubscriptions subscriptions;
    private final SocketRegistry sockets;
    private final ObjectMapper mapper;

    public PresenceBroadcastListener(PresenceSubscriptions subscriptions, SocketRegistry sockets,
                                     ObjectMapper mapper) {
        this.subscriptions = subscriptions;
        this.sockets = sockets;
        this.mapper = mapper;
    }

    @Override
    public void onMessage(org.springframework.data.redis.connection.Message message, byte[] pattern) {
        try {
            PresenceRegistry.PresenceState state = mapper.readValue(
                    new String(message.getBody(), StandardCharsets.UTF_8),
                    PresenceRegistry.PresenceState.class);

            Envelope envelope = Envelope.of(EnvelopeType.PRESENCE, new Frames.Presence(
                    state.userId(), state.status(), state.lastSeenAt()));

            for (UUID deviceId : subscriptions.watchersOf(state.userId())) {
                sockets.deliver(deviceId, envelope);
            }
        } catch (Exception e) {
            // Presence is best-effort; a dropped update is corrected by the next one or by the
            // snapshot the client gets on its next subscribe.
            log.warn("Could not handle a presence broadcast", e);
        }
    }

    @Configuration
    static class ListenerRegistration {

        @Bean
        RedisMessageListenerContainer presenceListenerContainer(
                RedisConnectionFactory connectionFactory, PresenceBroadcastListener listener) {
            RedisMessageListenerContainer container = new RedisMessageListenerContainer();
            container.setConnectionFactory(connectionFactory);
            container.addMessageListener(listener, new ChannelTopic(PresenceRegistry.CHANNEL));
            return container;
        }
    }
}
