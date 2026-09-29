package com.chatter.chat.domain;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Per-conversation monotonic sequence. Clients order by this, never by timestamp: clocks lie, and
 * distributed clocks lie in interesting ways (LLD DD-2).
 *
 * <p>Redis is the fast path. If Redis is unavailable we fall back to an atomic UPDATE..RETURNING
 * on the conversation row -- slower, but it means a Redis outage degrades latency rather than
 * stopping messaging.
 */
@Component
public class ConversationSequencer {

    private static final Logger log = LoggerFactory.getLogger(ConversationSequencer.class);

    private final StringRedisTemplate redis;
    private final JdbcTemplate jdbc;

    private final io.micrometer.core.instrument.MeterRegistry metrics;

    public ConversationSequencer(StringRedisTemplate redis, JdbcTemplate jdbc,
                                 io.micrometer.core.instrument.MeterRegistry metrics) {
        this.redis = redis;
        this.jdbc = jdbc;
        this.metrics = metrics;
    }

    public long next(java.util.UUID conversationId) {
        String key = "conv:" + conversationId + ":seq";
        try {
            Long value = redis.opsForValue().increment(key);
            if (value != null) {
                // Cold Redis starts the counter at 1, which would re-issue sequences that already
                // exist. Seed from the database the first time we see a conversation.
                if (value == 1L) {
                    long persisted = persistedLastSeq(conversationId);
                    if (persisted > 0) {
                        redis.opsForValue().set(key, Long.toString(persisted + 1));
                        return persisted + 1;
                    }
                }
                return value;
            }
        } catch (DataAccessException e) {
            log.warn("Redis sequencer unavailable for {}; falling back to the database",
                    conversationId, e);
            metrics.counter("chatter.sequencer.fallback").increment();
        }
        return databaseNext(conversationId);
    }

    private long persistedLastSeq(java.util.UUID conversationId) {
        Long value = jdbc.queryForObject(
                "SELECT last_seq FROM conversations WHERE id = ?", Long.class, conversationId);
        return value == null ? 0L : value;
    }

    private long databaseNext(java.util.UUID conversationId) {
        Long value = jdbc.queryForObject(
                "UPDATE conversations SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
                Long.class, conversationId);
        if (value == null) {
            throw new IllegalStateException("Conversation " + conversationId + " does not exist");
        }
        return value;
    }
}
