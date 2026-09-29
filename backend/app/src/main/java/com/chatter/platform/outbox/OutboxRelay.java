package com.chatter.platform.outbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Limit;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Drains the outbox to Kafka. A poller rather than Debezium because it is fifty lines instead of
 * a CDC deployment, and the swap is invisible to everything upstream.
 *
 * <p>Delivery is at-least-once: a crash after the Kafka send but before the commit replays the
 * event. That is safe because every downstream consumer is idempotent on messageId.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    private static final int BATCH = 200;

    private final OutboxRepository repository;
    private final KafkaTemplate<String, String> kafka;

    public OutboxRelay(OutboxRepository repository, KafkaTemplate<String, String> kafka) {
        this.repository = repository;
        this.kafka = kafka;
    }

    @Scheduled(fixedDelayString = "${chatter.outbox.poll-interval-ms:200}")
    @Transactional
    public void drain() {
        List<OutboxEntity> batch = repository.claimUnpublished(Limit.of(BATCH));
        if (batch.isEmpty()) {
            return;
        }
        for (OutboxEntity event : batch) {
            try {
                kafka.send(event.getTopic(), event.getPartitionKey(), event.getPayload()).join();
                event.markPublished();
            } catch (Exception e) {
                // Leave it unpublished and stop the batch: order within a partition key matters
                // more than throughput, and the next tick will retry from here.
                log.warn("Outbox publish failed for id={} topic={}; will retry",
                        event.getId(), event.getTopic(), e);
                break;
            }
        }
    }
}
