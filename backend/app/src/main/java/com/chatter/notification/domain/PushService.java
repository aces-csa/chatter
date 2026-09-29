package com.chatter.notification.domain;

import com.chatter.chat.api.ConversationMembership;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.platform.config.KafkaTopicsConfig;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Web Push for devices that are not connected (FR-8.1, HLD section 3 notification-service).
 *
 * <p>The payload carries ids only -- conversation, sender, message -- never content, which the
 * server does not have. The service worker turns those ids into "Alice in Weekend plans" from
 * the names already stored on the device, so the notification is readable without the server
 * ever learning, or sending through a third-party push service, anything more than routing data.
 *
 * <p>Consumes message.created on its own consumer group, so a slow push service can never hold
 * up live delivery on the fan-out group.
 */
@Service
public class PushService {

    private static final Logger log = LoggerFactory.getLogger(PushService.class);
    /** Pushes older than this are not worth showing; the user will see the chat on next open. */
    private static final Duration TTL = Duration.ofDays(1);

    private final JdbcTemplate jdbc;
    private final WebPushSender sender;
    private final RealtimeDelivery delivery;
    private final ConversationMembership membership;
    private final ObjectMapper mapper;
    private final List<String> allowedHosts;
    private final io.micrometer.core.instrument.MeterRegistry metrics;
    private final com.chatter.user.api.PrivacyDirectory privacy;

    public PushService(JdbcTemplate jdbc, WebPushSender sender, RealtimeDelivery delivery,
                       ConversationMembership membership, ObjectMapper mapper,
                       @org.springframework.beans.factory.annotation.Value(
                               "${chatter.push.allowed-hosts:fcm.googleapis.com,push.services.mozilla.com,notify.windows.com,push.apple.com}")
                       List<String> allowedHosts,
                       io.micrometer.core.instrument.MeterRegistry metrics,
                       com.chatter.user.api.PrivacyDirectory privacy) {
        this.privacy = privacy;
        this.jdbc = jdbc;
        this.sender = sender;
        this.delivery = delivery;
        this.membership = membership;
        this.mapper = mapper;
        this.allowedHosts = allowedHosts.stream().map(String::trim).map(h -> h.toLowerCase(java.util.Locale.ROOT)).toList();
        this.metrics = metrics;
    }

    /** The subset of chat's MessageCreatedEvent this module needs; chat's type is not ours to import. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record MessageCreated(UUID messageId, UUID conversationId, UUID senderId, String encoding,
                          List<Target> targets, boolean silent, List<UUID> mentions) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Target(UUID userId, UUID deviceId) {
        }
    }

    /**
     * Endpoints must be https: the server makes a request to whatever URL a client registers,
     * and plain http would let one point that request at internal services.
     */
    public void subscribe(UUID deviceId, String endpoint, String p256dh, String auth) {
        URI uri;
        try {
            uri = URI.create(endpoint);
        } catch (IllegalArgumentException e) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Invalid push endpoint");
        }
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Push endpoints must be https");
        }
        // Allow-list, not just https: otherwise the server can be made to POST to any https host
        // a client names, which is a request-forgery primitive.
        String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
        boolean known = allowedHosts.stream().anyMatch(h -> host.equals(h) || host.endsWith("." + h));
        if (!known) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Unrecognised push service");
        }
        // The same browser re-subscribing (or a new login in it) takes the endpoint over.
        jdbc.update("""
                        INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (endpoint) DO UPDATE
                           SET device_id = EXCLUDED.device_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
                        """,
                Ids.next(), deviceId, endpoint, p256dh, auth);
    }

    public void unsubscribe(UUID deviceId, String endpoint) {
        jdbc.update("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?", deviceId, endpoint);
    }

    @KafkaListener(topics = KafkaTopicsConfig.MESSAGE_CREATED, groupId = "chatter-push", concurrency = "2")
    public void onMessageCreated(String rawEvent) {
        MessageCreated event;
        try {
            event = mapper.readValue(rawEvent, MessageCreated.class);
        } catch (Exception e) {
            log.warn("Cannot read message.created for push; skipping", e);
            return;
        }
        // Timeline events ("X added Y") are not worth waking someone for.
        // Reactions, edits and deletes arrive silently; so do timeline events.
        if (event.silent() || "system/v1".equals(event.encoding()) || event.targets() == null) {
            return;
        }

        Set<UUID> muted = new java.util.HashSet<>(membership.mutedMembers(event.conversationId()));
        // FR-4.7: a mention gets through a muted group. FR-8.4: quiet hours get through nothing.
        if (event.mentions() != null) {
            event.mentions().forEach(muted::remove);
        }
        muted.addAll(privacy.inQuietHours(event.targets().stream().map(MessageCreated.Target::userId).distinct().toList(),
                java.time.Instant.now()));
        Map<UUID, UUID> candidates = new HashMap<>();
        for (MessageCreated.Target target : event.targets()) {
            // Never notify people about their own messages on their other devices.
            if (!target.userId().equals(event.senderId()) && !muted.contains(target.userId())) {
                candidates.put(target.deviceId(), target.userId());
            }
        }
        if (candidates.isEmpty()) {
            return;
        }
        candidates.keySet().removeAll(delivery.onlineDevices(candidates));
        if (candidates.isEmpty()) {
            return;
        }

        byte[] payload;
        try {
            payload = mapper.writeValueAsString(Map.of(
                    "type", "message",
                    "conversationId", event.conversationId(),
                    "senderId", event.senderId(),
                    "messageId", event.messageId())).getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return;
        }
        // Topic must be URL-safe and at most 32 characters: a UUID without dashes is exactly that.
        String topic = event.conversationId().toString().replace("-", "");

        for (WebPushSender.Subscription subscription : subscriptionsFor(candidates.keySet())) {
            sender.send(subscription, payload, topic, TTL).whenComplete((status, error) -> {
                metrics.counter("chatter.push.sent", "outcome",
                        error != null ? "error" : status < 300 ? "ok" : status == 404 || status == 410 ? "gone" : "rejected")
                        .increment();
                if (error != null) {
                    log.debug("Push to {} failed", host(subscription.endpoint()), error);
                } else if (status == 404 || status == 410) {
                    // The browser dropped the subscription (uninstalled, permission revoked).
                    jdbc.update("DELETE FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint());
                } else if (status >= 400) {
                    log.warn("Push service {} answered {}", host(subscription.endpoint()), status);
                }
            });
        }
    }

    private List<WebPushSender.Subscription> subscriptionsFor(Set<UUID> deviceIds) {
        return jdbc.query("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE device_id = ANY(?)",
                (rs, n) -> new WebPushSender.Subscription(rs.getString(1), rs.getString(2), rs.getString(3)),
                (Object) deviceIds.toArray(UUID[]::new));
    }

    /** Endpoint URLs are bearer capabilities; log only the host. */
    private static String host(String endpoint) {
        try {
            return URI.create(endpoint).getHost();
        } catch (IllegalArgumentException e) {
            return "?";
        }
    }
}
