package com.chatter.gateway.ws;

import com.chatter.common.wire.Envelope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Which devices are connected to <em>this</em> node. In-memory on purpose: it is a cache of
 * facts that die with the process, and Redis already holds the cluster-wide view.
 */
@Component
public class SocketRegistry {

    private static final Logger log = LoggerFactory.getLogger(SocketRegistry.class);
    private static final String DESTINATION = "/queue/events";

    private final Map<UUID, UUID> deviceToUser = new ConcurrentHashMap<>();
    private final SimpMessagingTemplate messaging;

    private final io.micrometer.core.instrument.Timer deliveryLatency;

    public SocketRegistry(SimpMessagingTemplate messaging,
                          io.micrometer.core.instrument.MeterRegistry metrics) {
        this.messaging = messaging;
        // HLD section 6: sockets per gateway is the capacity number for this node.
        io.micrometer.core.instrument.Gauge.builder("chatter.gateway.sockets", deviceToUser, Map::size)
                .description("Devices with a live, subscribed socket on this node")
                .register(metrics);
        this.deliveryLatency = io.micrometer.core.instrument.Timer.builder("chatter.delivery.latency")
                .description("Server ingest to push onto the recipient's socket")
                .publishPercentileHistogram()
                .register(metrics);
    }

    public void add(UUID userId, UUID deviceId) {
        deviceToUser.put(deviceId, userId);
    }

    public void remove(UUID deviceId) {
        deviceToUser.remove(deviceId);
    }

    public boolean holds(UUID deviceId) {
        return deviceToUser.containsKey(deviceId);
    }

    public int size() {
        return deviceToUser.size();
    }

    public Set<UUID> connectedDevices() {
        return Set.copyOf(deviceToUser.keySet());
    }

    public Map<UUID, UUID> snapshot() {
        return Map.copyOf(deviceToUser);
    }

    /**
     * Sends to one device. If the device is not on this node the call is a no-op rather than an
     * error: a stale route entry is an expected, harmless condition.
     */
    public void deliver(UUID deviceId, Envelope envelope) {
        if (!deviceToUser.containsKey(deviceId)) {
            log.debug("Device {} is not on this gateway; dropping delivery", deviceId);
            return;
        }
        messaging.convertAndSendToUser(deviceId.toString(), DESTINATION, envelope);
        recordLatency(envelope);
    }

    /** Ingest-to-socket for live messages: the HLD's p99 < 300 ms target is measured here. */
    private void recordLatency(Envelope envelope) {
        if (envelope.type() != com.chatter.common.wire.EnvelopeType.MESSAGE
                || !(envelope.payload() instanceof Map<?, ?> payload)
                || !(payload.get("createdAt") instanceof Number createdAt)) {
            return;
        }
        long elapsed = System.currentTimeMillis() - createdAt.longValue();
        if (elapsed >= 0) {
            deliveryLatency.record(java.time.Duration.ofMillis(elapsed));
        }
    }
}
