package com.chatter.delivery.domain;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.Frames;
import com.chatter.delivery.api.RealtimeDelivery;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;

/**
 * Resolves users to devices, devices to gateways, and publishes one batch per gateway.
 *
 * <p>Grouping by gateway is the point: a fan-out to N recipients costs one publish per gateway
 * node, not one per device.
 *
 * <p>These publishes go straight to Redis rather than through Kafka and the outbox. Receipts,
 * typing and presence are high-volume, ephemeral and idempotent -- a lost receipt costs a stale
 * tick that the next one corrects, which does not justify the durability machinery a message
 * needs. Messages themselves still come through the outbox.
 */
@Service
public class RealtimeNotifier implements RealtimeDelivery {

    private static final Logger log = LoggerFactory.getLogger(RealtimeNotifier.class);

    private final RouteRegistry routes;
    private final DeviceDirectory devices;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    public RealtimeNotifier(RouteRegistry routes, DeviceDirectory devices,
                            StringRedisTemplate redis, ObjectMapper mapper) {
        this.routes = routes;
        this.devices = devices;
        this.redis = redis;
        this.mapper = mapper;
    }

    @Override
    public void notifyUsers(List<UUID> userIds, Envelope envelope) {
        broadcast(userIds, envelope, deviceId -> true);
    }

    @Override
    public void notifyUsersExceptDevice(List<UUID> userIds, Envelope envelope, UUID exceptDevice) {
        broadcast(userIds, envelope, deviceId -> !deviceId.equals(exceptDevice));
    }

    private void broadcast(List<UUID> userIds, Envelope envelope, Predicate<UUID> include) {
        if (userIds.isEmpty()) {
            return;
        }
        List<DeviceEnvelope> targeted = devices.findByUsers(userIds).stream()
                .filter(device -> include.test(device.id()))
                .map(device -> new DeviceEnvelope(device.userId(), device.id(), envelope))
                .toList();
        deliverToDevices(targeted);
    }

    @Override
    public java.util.Set<UUID> onlineDevices(java.util.Map<UUID, UUID> devices) {
        List<RouteRegistry.DeviceRoute> candidates = devices.entrySet().stream()
                .map(e -> new RouteRegistry.DeviceRoute(e.getValue(), e.getKey(), null))
                .toList();
        return routes.resolve(candidates).values().stream()
                .flatMap(List::stream)
                .map(RouteRegistry.DeviceRoute::deviceId)
                .collect(java.util.stream.Collectors.toSet());
    }

    /** Tells a revoked device to sign out now, instead of when its access token runs out. */
    @org.springframework.transaction.event.TransactionalEventListener
    public void onDeviceRevoked(com.chatter.auth.api.DeviceRevokedEvent event) {
        deliverToDevices(List.of(new DeviceEnvelope(event.userId(), event.deviceId(),
                com.chatter.common.wire.Envelope.of(com.chatter.common.wire.EnvelopeType.ERROR,
                        new com.chatter.common.wire.Frames.Error("DEVICE_REVOKED",
                                "This device was logged out from another device")))));
    }

    @Override
    public void deliverToDevices(List<DeviceEnvelope> targeted) {
        if (targeted.isEmpty()) {
            return;
        }

        List<RouteRegistry.DeviceRoute> candidates = targeted.stream()
                .map(t -> new RouteRegistry.DeviceRoute(t.userId(), t.deviceId(), null))
                .toList();

        Map<String, List<RouteRegistry.DeviceRoute>> online = routes.resolve(candidates);
        if (online.isEmpty()) {
            return;
        }

        Map<UUID, Envelope> envelopeByDevice = new HashMap<>(targeted.size());
        for (DeviceEnvelope target : targeted) {
            envelopeByDevice.put(target.deviceId(), target.envelope());
        }

        for (Map.Entry<String, List<RouteRegistry.DeviceRoute>> entry : online.entrySet()) {
            List<Frames.Delivery> deliveries = new ArrayList<>(entry.getValue().size());
            for (RouteRegistry.DeviceRoute route : entry.getValue()) {
                Envelope envelope = envelopeByDevice.get(route.deviceId());
                if (envelope != null) {
                    deliveries.add(new Frames.Delivery(route.userId(), route.deviceId(), envelope));
                }
            }
            if (!deliveries.isEmpty()) {
                publish(entry.getKey(), new Frames.GatewayPush(deliveries));
            }
        }
    }

    private void publish(String gatewayId, Frames.GatewayPush push) {
        try {
            redis.convertAndSend(RouteRegistry.channel(gatewayId), mapper.writeValueAsString(push));
        } catch (Exception e) {
            // Recipients recover on their next SYNC; failing loudly would not deliver it sooner.
            log.warn("Failed to publish to gateway {}", gatewayId, e);
        }
    }
}
