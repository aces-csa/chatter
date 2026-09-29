package com.chatter.gateway.config;

import com.chatter.gateway.ws.AuthChannelInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

import java.util.List;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final AuthChannelInterceptor authInterceptor;
    private final List<String> allowedOrigins;
    private final com.chatter.gateway.ws.LiveSessions liveSessions;

    public WebSocketConfig(AuthChannelInterceptor authInterceptor,
                           com.chatter.gateway.ws.LiveSessions liveSessions,
                           @Value("${chatter.cors.allowed-origins:http://localhost:5173}")
                           List<String> allowedOrigins) {
        this.authInterceptor = authInterceptor;
        this.liveSessions = liveSessions;
        this.allowedOrigins = allowedOrigins;
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOrigins(allowedOrigins.toArray(String[]::new))
                // SockJS stays on as the fallback for networks that break raw WebSocket.
                .withSockJS();
        registry.setErrorHandler(new com.chatter.gateway.ws.RefusalErrorHandler());
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // A simple in-memory broker is correct here: this node owns its sockets, and cross-node
        // delivery goes through Redis rather than a broker relay, which keeps the hot path at
        // one hop (LLD DD-1).
        registry.enableSimpleBroker("/queue", "/topic")
                .setHeartbeatValue(new long[]{30_000, 30_000})
                .setTaskScheduler(heartbeatScheduler());
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(authInterceptor);
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        registration.setMessageSizeLimit(256 * 1024);
        // Beyond this the session is closed rather than allowed to accumulate heap. Losing one
        // slow socket is much better than an OOM that takes every other socket on the node.
        registration.setSendBufferSizeLimit(512 * 1024);
        registration.setSendTimeLimit(20_000);
        // Track raw sessions so a draining node can close them deliberately.
        registration.addDecoratorFactory(liveSessions::decorate);
    }

    private org.springframework.scheduling.TaskScheduler heartbeatScheduler() {
        var scheduler = new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("ws-heartbeat-");
        scheduler.initialize();
        return scheduler;
    }
}
