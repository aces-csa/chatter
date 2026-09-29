package com.chatter.platform.outbox;

import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.QueryHints;

import java.util.List;

public interface OutboxRepository extends JpaRepository<OutboxEntity, Long> {

    /**
     * SKIP LOCKED lets several app instances drain the outbox concurrently without any of them
     * blocking on a row another one already claimed.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@jakarta.persistence.QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
    @Query("select o from OutboxEntity o where o.publishedAt is null order by o.id")
    List<OutboxEntity> claimUnpublished(Limit limit);
}
