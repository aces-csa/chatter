package com.chatter.chat.fanout;

import com.chatter.chat.domain.MessageCreatedEvent;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.platform.config.KafkaTopicsConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Turns one persisted message into one delivery per recipient device.
 *
 * <p>Each device gets only the ciphertext addressed to it, so the frame a client receives is
 * already narrowed to what it can actually decrypt. That is why this uses the per-device
 * delivery call rather than a broadcast: under E2EE there is nothing shared to broadcast.
 */
@Component
public class MessageFanoutListener {

    private static final Logger log = LoggerFactory.getLogger(MessageFanoutListener.class);

    private final RealtimeDelivery delivery;
    private final ObjectMapper mapper;

    private final io.micrometer.core.instrument.MeterRegistry metrics;

    public MessageFanoutListener(RealtimeDelivery delivery, ObjectMapper mapper,
                                 io.micrometer.core.instrument.MeterRegistry metrics) {
        this.delivery = delivery;
        this.mapper = mapper;
        this.metrics = metrics;
    }

    @KafkaListener(topics = KafkaTopicsConfig.MESSAGE_CREATED,
            groupId = "chatter-fanout",
            concurrency = "4")
    public void onMessageCreated(String rawEvent) {
        MessageCreatedEvent event;
        try {
            event = mapper.readValue(rawEvent, MessageCreatedEvent.class);
        } catch (Exception e) {
            // A poison message must not stall the partition forever. Log and drop: the message
            // is still durably stored and the recipient will get it on their next SYNC.
            log.error("Cannot deserialise message.created event; dropping", e);
            return;
        }

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
    }
}
