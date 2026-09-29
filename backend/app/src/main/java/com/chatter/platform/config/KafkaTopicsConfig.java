package com.chatter.platform.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Topics are keyed by conversationId so per-conversation ordering survives the bus -- the same
 * invariant the sequence counter establishes in the database (LLD 4.5).
 *
 * <p>Every consumed topic has a {@code .DLT} twin with the same partition count: a dead-lettered
 * record keeps its original partition, so ordering context survives for whoever replays it.
 */
@Configuration
public class KafkaTopicsConfig {

    public static final String MESSAGE_CREATED = "message.created";
    public static final String MESSAGE_DELIVERED = "message.delivered";
    public static final String PUSH_NOTIFY = "push.notify";
    public static final String DLT_SUFFIX = ".DLT";

    private static final int MESSAGE_CREATED_PARTITIONS = 8;
    private static final int PUSH_NOTIFY_PARTITIONS = 4;

    @Bean
    NewTopic messageCreatedTopic() {
        return TopicBuilder.name(MESSAGE_CREATED).partitions(MESSAGE_CREATED_PARTITIONS).replicas(1).build();
    }

    @Bean
    NewTopic messageCreatedDeadLetterTopic() {
        return TopicBuilder.name(MESSAGE_CREATED + DLT_SUFFIX).partitions(MESSAGE_CREATED_PARTITIONS).replicas(1).build();
    }

    @Bean
    NewTopic messageDeliveredTopic() {
        return TopicBuilder.name(MESSAGE_DELIVERED).partitions(4).replicas(1).build();
    }

    @Bean
    NewTopic pushNotifyTopic() {
        return TopicBuilder.name(PUSH_NOTIFY).partitions(PUSH_NOTIFY_PARTITIONS).replicas(1).build();
    }

    @Bean
    NewTopic pushNotifyDeadLetterTopic() {
        return TopicBuilder.name(PUSH_NOTIFY + DLT_SUFFIX).partitions(PUSH_NOTIFY_PARTITIONS).replicas(1).build();
    }
}
