package com.chatter.chat.domain;

import com.chatter.chat.api.ChatDtos;
import com.chatter.common.error.AppException;
import com.chatter.user.api.PrivacyDirectory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Message info (FR-4.8): for one of your messages, when each recipient's devices received it and
 * when they read it. Built from the inbox pointers the fan-out already writes, so it costs no
 * extra writes on the send path.
 *
 * <p>Read times respect read-receipt privacy both ways: if either you or the recipient turned
 * receipts off, the recipient's read time is withheld, exactly as the blue ticks are.
 */
@Service
public class MessageInfoService {

    private final JdbcTemplate jdbc;
    private final MessageStore messageStore;
    private final PrivacyDirectory privacy;

    public MessageInfoService(JdbcTemplate jdbc, MessageStore messageStore, PrivacyDirectory privacy) {
        this.jdbc = jdbc;
        this.messageStore = messageStore;
        this.privacy = privacy;
    }

    public List<ChatDtos.MessageReceipt> info(UUID requester, UUID conversationId, UUID messageId) {
        MessageStore.MessageMeta meta = messageStore.findMeta(messageId)
                .filter(m -> m.conversationId().equals(conversationId))
                .orElseThrow(() -> AppException.notFound("Message"));
        if (!meta.senderId().equals(requester)) {
            throw AppException.forbidden("Only the sender can see message info");
        }
        Long seq = jdbc.queryForObject("SELECT seq FROM messages WHERE id = ?", Long.class, messageId);

        List<ChatDtos.MessageReceipt> rows = jdbc.query("""
                        SELECT user_id, delivered_at, read_at FROM inbox
                        WHERE conversation_id = ? AND seq = ?
                        ORDER BY read_at NULLS LAST, delivered_at NULLS LAST
                        """,
                (rs, n) -> new ChatDtos.MessageReceipt(
                        rs.getObject("user_id", UUID.class),
                        toInstant(rs.getTimestamp("delivered_at")),
                        toInstant(rs.getTimestamp("read_at"))),
                conversationId, seq);

        Set<UUID> hidden = privacy.receiptsDisabled(
                java.util.stream.Stream.concat(rows.stream().map(ChatDtos.MessageReceipt::userId), java.util.stream.Stream.of(requester)).toList());
        boolean requesterHidden = hidden.contains(requester);
        return rows.stream()
                .map(r -> requesterHidden || hidden.contains(r.userId())
                        ? new ChatDtos.MessageReceipt(r.userId(), r.deliveredAt(), null)
                        : r)
                .toList();
    }

    private static java.time.Instant toInstant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
