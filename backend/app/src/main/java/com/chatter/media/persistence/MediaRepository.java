package com.chatter.media.persistence;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface MediaRepository extends JpaRepository<MediaEntity, UUID> {

    @Query("select m from MediaEntity m where m.state = 'PENDING' and m.createdAt < :before")
    List<MediaEntity> findAbandoned(@Param("before") Instant before);
}
