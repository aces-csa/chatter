package com.chatter.chat.domain;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * Deletes disappearing messages from the server once their timer runs out. Clients delete their
 * local copies on the same clock; this is the half that makes the promise true for the one copy
 * the user cannot see -- ours.
 *
 * <p>Batched so one busy minute cannot hold a long transaction over the messages table.
 */
@Component
public class MessageExpiryJob {

    private static final Logger log = LoggerFactory.getLogger(MessageExpiryJob.class);
    private static final int BATCH = 1_000;
    private static final int MAX_BATCHES_PER_RUN = 50;

    private final MessageStore messageStore;

    public MessageExpiryJob(MessageStore messageStore) {
        this.messageStore = messageStore;
    }

    @Scheduled(fixedDelayString = "${chatter.messages.expiry-sweep-ms:60000}")
    public void purge() {
        int total = 0;
        for (int i = 0; i < MAX_BATCHES_PER_RUN; i++) {
            int purged = messageStore.purgeExpired(Instant.now(), BATCH);
            total += purged;
            if (purged < BATCH) {
                break;
            }
        }
        if (total > 0) {
            log.info("Purged {} expired disappearing messages", total);
        }
    }
}
