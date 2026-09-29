package com.chatter.chat.persistence;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ConversationMemberRepository
        extends JpaRepository<ConversationMemberEntity, ConversationMemberEntity.Key> {

    @Query("select m from ConversationMemberEntity m "
            + "where m.id.conversationId = :conversationId and m.leftAt is null")
    List<ConversationMemberEntity> findActiveMembers(@Param("conversationId") UUID conversationId);

    @Query("select m from ConversationMemberEntity m "
            + "where m.id.conversationId = :conversationId and m.id.userId = :userId "
            + "and m.leftAt is null")
    Optional<ConversationMemberEntity> findActiveMember(
            @Param("conversationId") UUID conversationId, @Param("userId") UUID userId);

    @Query("select m from ConversationMemberEntity m "
            + "where m.id.userId = :userId and m.leftAt is null")
    List<ConversationMemberEntity> findMembershipsOf(@Param("userId") UUID userId);
}
