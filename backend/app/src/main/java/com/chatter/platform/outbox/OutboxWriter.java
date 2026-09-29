package com.chatter.platform.outbox;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Enqueue an event in the same transaction that writes the aggregate. Without this, a crash
 * between "message saved" and "message published" loses a message silently, which is the one
 * failure mode a messenger may never have (LLD DD-6).
 */
@Component
public class OutboxWriter {

    private final OutboxRepository repository;
    private final ObjectMapper mapper;

    public OutboxWriter(OutboxRepository repository, ObjectMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    public void enqueue(String topic, UUID partitionKey, Object event) {
        try {
            repository.save(new OutboxEntity(
                    partitionKey, topic, partitionKey.toString(), mapper.writeValueAsString(event)));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot serialise outbox event for " + topic, e);
        }
    }
}
