package com.chatter.gateway.routing;

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

/**
 * Receives deliveries addressed to this gateway and pushes them down the right sockets.
 * This is the last hop of ingest to delivery.
 */
@Component
public class GatewayPushListener implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(GatewayPushListener.class);

    private final SocketRegistry sockets;
    private final ObjectMapper mapper;

    public GatewayPushListener(SocketRegistry sockets, ObjectMapper mapper) {
        this.sockets = sockets;
        this.mapper = mapper;
    }

    @Override
    public void onMessage(org.springframework.data.redis.connection.Message message,
                          byte[] pattern) {
        try {
            Frames.GatewayPush push = mapper.readValue(
                    new String(message.getBody(), StandardCharsets.UTF_8), Frames.GatewayPush.class);
            for (Frames.Delivery delivery : push.deliveries()) {
                sockets.deliver(delivery.deviceId(), delivery.envelope());
            }
        } catch (Exception e) {
            // Dropping is safe: the message is durably stored and the client's next SYNC
            // will pick it up. Failing loudly here would not get it delivered any sooner.
            log.error("Cannot handle gateway push; affected clients will recover on SYNC", e);
        }
    }

    @Configuration
    static class ListenerRegistration {

        @Bean
        RedisMessageListenerContainer gatewayListenerContainer(
                RedisConnectionFactory connectionFactory,
                GatewayPushListener listener,
                RouteRegistry routes) {
            RedisMessageListenerContainer container = new RedisMessageListenerContainer();
            container.setConnectionFactory(connectionFactory);
            container.addMessageListener(listener, new ChannelTopic(routes.channel()));
            return container;
        }
    }
}
