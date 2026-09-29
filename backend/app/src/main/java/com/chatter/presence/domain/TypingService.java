package com.chatter.presence.domain;

import com.chatter.chat.api.ConversationMembership;
import com.chatter.common.wire.Envelope;
import com.chatter.common.wire.EnvelopeType;
import com.chatter.common.wire.Frames;
import com.chatter.delivery.api.RealtimeDelivery;
import com.chatter.presence.api.PresenceDtos;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

/**
 * Typing indicators. Routed through the app rather than handled in the gateway because it needs
 * the conversation's membership, which is the app's data -- letting the gateway read that
 * directly would couple it to a schema it has no business knowing.
 *
 * <p>Never persisted. A typing state is worthless five seconds later, so it lives in Redis with a
 * short TTL and is allowed to be lost.
 */
@Service
public class TypingService {

    private static final Duration TTL = Duration.ofSeconds(5);

    private final ConversationMembership membership;
    private final RealtimeDelivery delivery;
    private final StringRedisTemplate redis;

    public TypingService(ConversationMembership membership, RealtimeDelivery delivery,
                         StringRedisTemplate redis) {
        this.membership = membership;
        this.delivery = delivery;
        this.redis = redis;
    }

    public void handle(PresenceDtos.TypingRequest request) {
        membership.assertMember(request.userId(), request.conversationId());

        String key = "typing:" + request.conversationId();
        boolean starting = !"stop".equalsIgnoreCase(request.state());

        if (starting) {
            redis.opsForSet().add(key, request.userId().toString());
            // Refreshed by each keystroke batch; if the sender goes away mid-sentence the
            // indicator expires on its own rather than sticking forever.
            redis.expire(key, TTL);
        } else {
            redis.opsForSet().remove(key, request.userId().toString());
        }

        List<UUID> recipients = membership.activeMemberIds(request.conversationId()).stream()
                .filter(id -> !id.equals(request.userId()))
                .toList();

        Envelope envelope = Envelope.of(EnvelopeType.TYPING, new Frames.TypingFrom(
                request.conversationId(), request.userId(), request.state()));

        delivery.notifyUsers(recipients, envelope);
    }
}
