package com.chatter.chat.persistence;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface GroupInviteRepository extends JpaRepository<GroupInviteEntity, String> {

    @Query("select i from GroupInviteEntity i "
            + "where i.conversationId = :conversationId and i.revoked = false")
    List<GroupInviteEntity> findUnrevoked(@Param("conversationId") UUID conversationId);
}
