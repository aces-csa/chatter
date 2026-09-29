package com.chatter.platform.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import io.micrometer.core.instrument.MeterRegistry;
import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.ExponentialBackOffWithMaxRetries;

/**
 * What every {@code @KafkaListener} does when it throws: retry in place with backoff, then park
 * the record on {@code <topic>.DLT} and move on.
 *
 * <p>Retries are blocking -- the partition waits -- which is deliberate: records are keyed by
 * conversation, and skipping ahead would reorder a chat. The budget is kept short (about 3.5 s)
 * so a transient Redis or database blip is ridden out, while a record that can never succeed
 * holds its partition for seconds, not forever.
 *
 * <p>Records that cannot be parsed skip the retries: re-reading the same bytes will not help.
 *
 * <p>Nothing is lost by dead-lettering a {@code message.created} record: the message is already
 * in Postgres and each recipient's inbox, so devices still receive it on their next SYNC. The DLT
 * keeps the record, with the failure in its headers, for inspection and replay.
 *
 * <p>Spring Boot applies a single {@link CommonErrorHandler} bean to the default listener
 * container factory, so every listener gets this without opting in.
 */
@Configuration
public class KafkaErrorHandlingConfig {

    private static final Logger log = LoggerFactory.getLogger(KafkaErrorHandlingConfig.class);

    @Bean
    CommonErrorHandler kafkaErrorHandler(KafkaTemplate<String, String> kafka, MeterRegistry metrics) {
        DeadLetterPublishingRecoverer deadLetters = new DeadLetterPublishingRecoverer(kafka,
                (record, error) -> new TopicPartition(record.topic() + KafkaTopicsConfig.DLT_SUFFIX, record.partition()));

        ExponentialBackOffWithMaxRetries backOff = new ExponentialBackOffWithMaxRetries(3);
        backOff.setInitialInterval(500);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(4_000);

        DefaultErrorHandler handler = new DefaultErrorHandler((record, error) -> {
            log.error("Dead-lettering {}-{}@{} after retries", record.topic(), record.partition(), record.offset(), error);
            metrics.counter("chatter.kafka.dead_lettered", "topic", record.topic()).increment();
            deadLetters.accept(record, error);
        }, backOff);
        handler.addNotRetryableExceptions(JsonProcessingException.class);
        return handler;
    }
}
