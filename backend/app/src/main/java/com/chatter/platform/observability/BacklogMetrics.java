package com.chatter.platform.observability;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Two of the four numbers the HLD says actually matter (section 6):
 *
 * <ul>
 *   <li>{@code chatter.outbox.backlog} -- persisted but not yet published. Growth means Kafka or
 *       the relay is behind, and delivery latency is about to follow.</li>
 *   <li>{@code chatter.inbox.undelivered} -- messages no recipient device has acknowledged.
 *       Steady growth with a healthy outbox means devices are offline, or delivery is broken.</li>
 * </ul>
 *
 * Sampled on a timer rather than computed per scrape, so a slow count can never make the metrics
 * endpoint itself slow. Both queries use partial indexes that cover only the rows being counted.
 * The other two -- sockets per gateway and consumer lag -- come from the gateway and from
 * Spring Kafka's built-in Micrometer consumer metrics.
 */
@Component
public class BacklogMetrics {

    private static final Logger log = LoggerFactory.getLogger(BacklogMetrics.class);

    private final JdbcTemplate jdbc;
    private final AtomicLong outbox = new AtomicLong();
    private final AtomicLong undelivered = new AtomicLong();

    public BacklogMetrics(JdbcTemplate jdbc, MeterRegistry registry) {
        this.jdbc = jdbc;
        Gauge.builder("chatter.outbox.backlog", outbox, AtomicLong::get)
                .description("Outbox rows not yet published to Kafka")
                .register(registry);
        Gauge.builder("chatter.inbox.undelivered", undelivered, AtomicLong::get)
                .description("Inbox pointers not yet acknowledged by any recipient device")
                .register(registry);
    }

    @Scheduled(fixedDelay = 15_000, initialDelay = 10_000)
    public void sample() {
        try {
            outbox.set(count("SELECT count(*) FROM outbox WHERE published_at IS NULL"));
            undelivered.set(count("SELECT count(*) FROM inbox WHERE state = 0"));
        } catch (DataAccessException e) {
            log.debug("Backlog sampling failed", e);
        }
    }

    private long count(String sql) {
        Long value = jdbc.queryForObject(sql, Long.class);
        return value == null ? 0 : value;
    }
}
