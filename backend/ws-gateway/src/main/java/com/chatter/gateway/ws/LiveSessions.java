package com.chatter.gateway.ws;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The raw WebSocket sessions on this node. STOMP hides them behind user destinations, which is
 * right for delivery, but draining a node needs something it can actually close.
 */
@Component
public class LiveSessions {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public WebSocketHandler decorate(WebSocketHandler handler) {
        return new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                sessions.put(session.getId(), session);
                super.afterConnectionEstablished(session);
            }

            @Override
            public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
                sessions.remove(session.getId());
                super.afterConnectionClosed(session, status);
            }
        };
    }

    public List<WebSocketSession> snapshot() {
        return List.copyOf(sessions.values());
    }

    public int size() {
        return sessions.size();
    }
}
