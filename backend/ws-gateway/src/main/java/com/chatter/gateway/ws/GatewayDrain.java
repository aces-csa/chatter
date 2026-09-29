package com.chatter.gateway.ws;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;

/**
 * Drain-on-deploy (HLD section 6). On shutdown this node:
 * <ol>
 *   <li>reports not-ready, so the load balancer stops sending new connections here;</li>
 *   <li>refuses new STOMP CONNECTs;</li>
 *   <li>closes its sockets in small batches spread over the drain window, with 1012 "service
 *       restart", so clients reconnect elsewhere a few at a time.</li>
 * </ol>
 * Closing 50 000 sockets at once would have 50 000 clients reconnect in the same second; client
 * jitter spreads that out, and spreading the closes spreads it further. Nothing is lost either
 * way: every client SYNCs its cursors on reconnect.
 *
 * <p>Highest phase, so it stops before the web server's own graceful shutdown.
 */
@Component
public class GatewayDrain implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(GatewayDrain.class);

    private final LiveSessions sessions;
    private final ApplicationEventPublisher events;
    private final long drainMillis;
    private volatile boolean running;
    private volatile boolean draining;

    public GatewayDrain(LiveSessions sessions, ApplicationEventPublisher events,
                        @Value("${chatter.gateway.drain-seconds:30}") long drainSeconds) {
        this.sessions = sessions;
        this.events = events;
        this.drainMillis = drainSeconds * 1000;
    }

    public boolean isDraining() {
        return draining;
    }

    @Override
    public void start() {
        running = true;
    }

    @Override
    public void stop() {
        draining = true;
        AvailabilityChangeEvent.publish(events, this, ReadinessState.REFUSING_TRAFFIC);

        List<WebSocketSession> open = sessions.snapshot();
        log.info("Draining {} sockets over {} ms", open.size(), drainMillis);
        int batches = Math.max(1, (int) Math.min(open.size(), drainMillis / 100));
        int perBatch = (int) Math.ceil(open.size() / (double) batches);
        long pause = open.isEmpty() ? 0 : drainMillis / batches;

        for (int i = 0; i < open.size(); i += perBatch) {
            for (WebSocketSession session : open.subList(i, Math.min(open.size(), i + perBatch))) {
                try {
                    if (session.isOpen()) {
                        session.close(CloseStatus.SERVICE_RESTARTED);
                    }
                } catch (IOException e) {
                    log.debug("Closing {} during drain failed", session.getId(), e);
                }
            }
            if (i + perBatch < open.size()) {
                try {
                    Thread.sleep(pause);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return Integer.MAX_VALUE;
    }
}
