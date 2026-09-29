package com.chatter.chat.fanout;

import com.chatter.chat.domain.MessageCreatedEvent;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.platform.config.KafkaTopicsConfig;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Turns one persisted message into one delivery per recipient device, and one push job for the
 * devices that are not connected.
 *
 * <p>Each device gets only the ciphertext addressed to it, so the frame a client receives is
 * already narrowed to what it can actually decrypt. That is why this uses the per-device
 * delivery call rather than a broadcast: under E2EE there is nothing shared to broadcast.
 *
 * <p>Failures are thrown, not swallowed: the shared Kafka error handler retries and then parks
 * the record on {@code message.created.DLT}. A retry may deliver a frame twice; clients dedupe by
 * message id.
 */
@Component
public class MessageFanoutListener {

    private final RealtimeDelivery delivery;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final io.micrometer.core.instrument.MeterRegistry metrics;

    public MessageFanoutListener(RealtimeDelivery delivery, ObjectMapper mapper, KafkaTemplate<String, String> kafka,
                                 io.micrometer.core.instrument.MeterRegistry metrics) {
        this.delivery = delivery;
        this.mapper = mapper;
        this.kafka = kafka;
        this.metrics = metrics;
    }

    @KafkaListener(topics = KafkaTopicsConfig.MESSAGE_CREATED,
            groupId = "chatter-fanout",
            concurrency = "4")
    public void onMessageCreated(String rawEvent) throws JsonProcessingException {
        MessageCreatedEvent event = mapper.readValue(rawEvent, MessageCreatedEvent.class);

        List<RealtimeDelivery.DeviceEnvelope> targeted = event.targets().stream()
                .map(target -> new RealtimeDelivery.DeviceEnvelope(
                        target.userId(),
                        target.deviceId(),
                        Envelope.of(EnvelopeType.MESSAGE, new Frames.Message(
                                event.messageId(), event.clientMessageId(), event.conversationId(),
                                event.senderId(), event.senderDeviceId(), event.seq(),
                                event.encoding(), target.cipherType(), target.ciphertext(),
                                event.groupCiphertext(), event.createdAt(), event.expiresAt()))))
                .toList();

        delivery.deliverToDevices(targeted);
        // Ingest to hand-off-to-gateways. The gateway records the last hop to the socket.
        metrics.timer("chatter.fanout.lag").record(
                java.time.Duration.ofMillis(Math.max(0, System.currentTimeMillis() - event.createdAt())));

        requestPush(event);
    }

    /**
     * Hands the offline devices to the notification module on {@code push.notify} (LLD 5.2).
     * Fan-out is the one place that already knows who was not connected, and the job carries ids
     * only -- no ciphertext -- so the push consumer never reads the heavy message event.
     *
     * <p>Mute, mention and quiet-hours policy stays with the notification module; this only says
     * "these devices missed it live".
     */
    private void requestPush(MessageCreatedEvent event) throws JsonProcessingException {
        // Reactions, edits, deletes and timeline events ("X added Y") are not worth waking someone for.
        if (event.silent() || "system/v1".equals(event.encoding())) {
            return;
        }
        Map<UUID, UUID> candidates = new HashMap<>();
        for (MessageCreatedEvent.Target target : event.targets()) {
            // Never notify people about their own messages on their other devices.
            if (!target.userId().equals(event.senderId())) {
                candidates.put(target.deviceId(), target.userId());
            }
        }
        if (candidates.isEmpty()) {
            return;
        }
        Set<UUID> online = delivery.onlineDevices(candidates);
        List<PushNotifyEvent.Device> offline = candidates.entrySet().stream()
                .filter(entry -> !online.contains(entry.getKey()))
                .map(entry -> new PushNotifyEvent.Device(entry.getValue(), entry.getKey()))
                .toList();
        if (offline.isEmpty()) {
            return;
        }
        PushNotifyEvent job = new PushNotifyEvent(event.messageId(), event.conversationId(), event.senderId(),
                event.createdAt(), event.mentions(), offline);
        // Synchronous so a failed publish fails this record and takes the retry / DLT path.
        kafka.send(KafkaTopicsConfig.PUSH_NOTIFY, event.conversationId().toString(), mapper.writeValueAsString(job))
                .join();
    }
}
