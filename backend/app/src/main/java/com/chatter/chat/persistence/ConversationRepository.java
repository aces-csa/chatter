package com.chatter.chat.persistence;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ConversationRepository extends JpaRepository<ConversationEntity, UUID> {

    Optional<ConversationEntity> findByPairKey(String pairKey);

    List<ConversationEntity> findByCreatedBy(UUID createdBy);

    @Query("""
            select c from ConversationEntity c
            where c.id in (
                select m.id.conversationId from ConversationMemberEntity m
                where m.id.userId = :userId and m.leftAt is null)
            order by c.lastMessageAt desc nulls last
            """)
    List<ConversationEntity> findForUser(@Param("userId") UUID userId);
}
