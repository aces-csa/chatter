package com.chatter.sealed.domain;

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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Delivers sealed envelopes to connected devices and asks for a push for the rest -- the same
 * shape as the identified fan-out, minus everything the server does not know. The push job has no
 * sender and no conversation, so the notification can only say "New message"; that is the cost
 * of the server not knowing who wrote to you.
 *
 * <p>Failures throw to the shared handler: retried, then parked on {@code sealed.created.DLT}.
 * Nothing is lost either way -- the rows stay until the device fetches and acknowledges them.
 */
@Component
public class SealedFanoutListener {

    private final RealtimeDelivery delivery;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;

    public SealedFanoutListener(RealtimeDelivery delivery, ObjectMapper mapper, KafkaTemplate<String, String> kafka) {
        this.delivery = delivery;
        this.mapper = mapper;
        this.kafka = kafka;
    }

    @KafkaListener(topics = KafkaTopicsConfig.SEALED_CREATED, groupId = "chatter-sealed-fanout", concurrency = "2")
    public void onSealedCreated(String rawEvent) throws JsonProcessingException {
        SealedMessageService.SealedCreatedEvent event =
                mapper.readValue(rawEvent, SealedMessageService.SealedCreatedEvent.class);
        UUID recipient = event.recipientUserId();

        delivery.deliverToDevices(event.items().stream()
                .map(item -> new RealtimeDelivery.DeviceEnvelope(recipient, item.deviceId(),
                        Envelope.of(EnvelopeType.SEALED, new Frames.Sealed(item.id(), item.ciphertext(), item.createdAt()))))
                .toList());

        Map<UUID, UUID> candidates = new HashMap<>();
        event.items().forEach(item -> candidates.put(item.deviceId(), recipient));
        Set<UUID> online = delivery.onlineDevices(candidates);
        List<Map<String, UUID>> offline = event.items().stream()
                .filter(item -> !online.contains(item.deviceId()))
                .map(item -> Map.of("userId", recipient, "deviceId", item.deviceId()))
                .toList();
        if (offline.isEmpty()) {
            return;
        }
        // The push.notify job shape, with the fields the server does not have left null.
        Map<String, Object> job = new LinkedHashMap<>();
        job.put("messageId", event.items().get(0).id());
        job.put("conversationId", null);
        job.put("senderId", null);
        job.put("createdAt", event.items().get(0).createdAt());
        job.put("mentions", null);
        job.put("devices", offline);
        kafka.send(KafkaTopicsConfig.PUSH_NOTIFY, recipient.toString(), mapper.writeValueAsString(job)).join();
    }
}
