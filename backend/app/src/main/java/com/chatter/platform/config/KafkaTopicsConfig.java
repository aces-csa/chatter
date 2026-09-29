package com.chatter.platform.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Topics are keyed by conversationId so per-conversation ordering survives the bus -- the same
 * invariant the sequence counter establishes in the database (LLD 4.5).
 */
@Configuration
public class KafkaTopicsConfig {

    public static final String MESSAGE_CREATED = "message.created";
    public static final String MESSAGE_DELIVERED = "message.delivered";
    public static final String PUSH_NOTIFY = "push.notify";

    @Bean
    NewTopic messageCreatedTopic() {
        return TopicBuilder.name(MESSAGE_CREATED).partitions(8).replicas(1).build();
    }

    @Bean
    NewTopic messageDeliveredTopic() {
        return TopicBuilder.name(MESSAGE_DELIVERED).partitions(4).replicas(1).build();
    }

    @Bean
    NewTopic pushNotifyTopic() {
        return TopicBuilder.name(PUSH_NOTIFY).partitions(4).replicas(1).build();
    }
}
