package com.chatter.chat.domain;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

/**
 * The fast half of the idempotency guard (LLD DD-5). The durable half is the
 * message_idempotency table; this just keeps the common case off the database.
 *
 * <p>Every failure here degrades to a database lookup, never to a duplicate message.
 */
@Component
public class IdempotencyCache {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyCache.class);
    private static final Duration TTL = Duration.ofHours(24);

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    public IdempotencyCache(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis = redis;
        this.mapper = mapper;
    }

    public Optional<MessageStore.StoredMessage> lookup(UUID senderDeviceId, UUID clientMessageId) {
        try {
            String cached = redis.opsForValue().get(key(senderDeviceId, clientMessageId));
            return cached == null
                    ? Optional.empty()
                    : Optional.of(mapper.readValue(cached, MessageStore.StoredMessage.class));
        } catch (DataAccessException | com.fasterxml.jackson.core.JsonProcessingException e) {
            log.debug("Idempotency cache lookup failed; falling through to the database", e);
            return Optional.empty();
        }
    }

    public void remember(UUID senderDeviceId, UUID clientMessageId,
                         MessageStore.StoredMessage message) {
        try {
            redis.opsForValue().set(
                    key(senderDeviceId, clientMessageId), mapper.writeValueAsString(message), TTL);
        } catch (DataAccessException | com.fasterxml.jackson.core.JsonProcessingException e) {
            log.debug("Idempotency cache write failed; the durable record still exists", e);
        }
    }

    private static String key(UUID deviceId, UUID clientMessageId) {
        return "idem:" + deviceId + ":" + clientMessageId;
    }
}
