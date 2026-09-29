package com.chatter.chat.persistence;

import com.chatter.chat.domain.MessageStore;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Plain JDBC rather than JPA. The messages table is range-partitioned with a composite primary
 * key and is append-only -- three things JPA handles badly and buys us nothing for.
 */
@Repository
public class PostgresMessageStore implements MessageStore {

    private final JdbcTemplate jdbc;

    public PostgresMessageStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    @Transactional
    public StoredMessage append(NewMessage m) {
        jdbc.update("""
                        INSERT INTO messages (conversation_id, seq, id, client_message_id, sender_id,
                                              sender_device_id, encoding, created_at, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                m.conversationId(), m.seq(), m.id(), m.clientMessageId(), m.senderId(),
                m.senderDeviceId(), m.encoding(), Timestamp.from(m.createdAt()),
                m.expiresAt() == null ? null : Timestamp.from(m.expiresAt()));

        jdbc.batchUpdate("""
                        INSERT INTO message_payloads (message_id, recipient_device_id, recipient_user_id,
                                                      conversation_id, seq, cipher_type, ciphertext, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                m.payloads(), m.payloads().size(),
                (ps, payload) -> {
                    ps.setObject(1, m.id());
                    ps.setObject(2, payload.recipientDeviceId());
                    ps.setObject(3, payload.recipientUserId());
                    ps.setObject(4, m.conversationId());
                    ps.setLong(5, m.seq());
                    ps.setShort(6, (short) payload.cipherType());
                    ps.setBytes(7, payload.ciphertext());
                    ps.setTimestamp(8, Timestamp.from(m.createdAt()));
                });

        if (m.groupCiphertext() != null) {
            jdbc.update("""
                            INSERT INTO message_group_payloads (message_id, ciphertext, created_at)
                            VALUES (?, ?, ?)
                            """,
                    m.id(), m.groupCiphertext(), Timestamp.from(m.createdAt()));
        }

        // The durable idempotency record. A unique index on the partitioned messages table would
        // have to include the partition key, which would not enforce what we actually need.
        jdbc.update("""
                        INSERT INTO message_idempotency (sender_device_id, client_message_id, message_id,
                                                         conversation_id, seq)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                m.senderDeviceId(), m.clientMessageId(), m.id(), m.conversationId(), m.seq());

        return new StoredMessage(m.id(), m.conversationId(), m.seq(), m.clientMessageId(),
                m.senderId(), m.senderDeviceId(), m.encoding(), m.createdAt(), m.expiresAt());
    }

    @Override
    public Optional<StoredMessage> findByClientMessageId(UUID senderDeviceId, UUID clientMessageId) {
        List<StoredMessage> found = jdbc.query("""
                        SELECT m.id, m.conversation_id, m.seq, m.client_message_id, m.sender_id,
                               m.sender_device_id, m.encoding, m.created_at, m.expires_at
                        FROM message_idempotency i
                        JOIN messages m ON m.id = i.message_id
                        WHERE i.sender_device_id = ? AND i.client_message_id = ?
                        """,
                MESSAGE_MAPPER, senderDeviceId, clientMessageId);
        return found.stream().findFirst();
    }

    @Override
    public List<AddressedMessage> readForDeviceAfter(UUID deviceId, UUID conversationId,
                                                     long afterSeq, int limit) {
        return jdbc.query("""
                        SELECT m.id, m.conversation_id, m.seq, m.client_message_id, m.sender_id,
                               m.sender_device_id, m.encoding, m.created_at, m.expires_at,
                               p.cipher_type, p.ciphertext, g.ciphertext AS group_ciphertext
                        FROM message_payloads p
                        JOIN messages m ON m.id = p.message_id
                        LEFT JOIN message_group_payloads g ON g.message_id = p.message_id
                        WHERE p.recipient_device_id = ? AND p.conversation_id = ? AND p.seq > ?
                          AND (m.expires_at IS NULL OR m.expires_at > now())
                        ORDER BY p.seq
                        LIMIT ?
                        """,
                (rs, rowNum) -> new AddressedMessage(
                        MESSAGE_MAPPER.mapRow(rs, rowNum),
                        rs.getShort("cipher_type"),
                        rs.getBytes("ciphertext"),
                        rs.getBytes("group_ciphertext")),
                deviceId, conversationId, afterSeq, limit);
    }

    @Override
    public List<UUID> conversationsWithBacklog(UUID deviceId) {
        return jdbc.queryForList("""
                        SELECT DISTINCT conversation_id FROM message_payloads WHERE recipient_device_id = ?
                        """,
                UUID.class, deviceId);
    }

    @Override
    public Optional<MessageMeta> findMeta(UUID messageId) {
        return jdbc.query("""
                        SELECT id, conversation_id, sender_id, created_at, deleted_for_all, encoding
                        FROM messages WHERE id = ?
                        """,
                (rs, n) -> new MessageMeta(
                        rs.getObject("id", UUID.class),
                        rs.getObject("conversation_id", UUID.class),
                        rs.getObject("sender_id", UUID.class),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getBoolean("deleted_for_all"),
                        rs.getString("encoding")),
                messageId).stream().findFirst();
    }

    @Override
    @Transactional
    public void markDeletedForAll(UUID messageId) {
        jdbc.update("UPDATE messages SET deleted_for_all = true WHERE id = ?", messageId);
        jdbc.update("DELETE FROM message_payloads WHERE message_id = ?", messageId);
        jdbc.update("DELETE FROM message_group_payloads WHERE message_id = ?", messageId);
    }

    @Override
    public void markEdited(UUID messageId, Instant editedAt) {
        jdbc.update("UPDATE messages SET edited_at = ? WHERE id = ?", Timestamp.from(editedAt), messageId);
    }

    @Override
    @Transactional
    public int purgeExpired(Instant now, int limit) {
        List<UUID> expired = jdbc.queryForList("""
                        SELECT id FROM messages
                        WHERE expires_at IS NOT NULL AND expires_at <= ?
                        ORDER BY expires_at
                        LIMIT ?
                        """,
                UUID.class, Timestamp.from(now), limit);
        if (expired.isEmpty()) {
            return 0;
        }
        UUID[] ids = expired.toArray(UUID[]::new);
        // Ciphertext first; the metadata row goes last so a crash midway leaves it findable by
        // the next run rather than orphaning payloads nobody will ever look for again.
        jdbc.update("DELETE FROM message_payloads WHERE message_id = ANY(?)", (Object) ids);
        jdbc.update("DELETE FROM message_group_payloads WHERE message_id = ANY(?)", (Object) ids);
        jdbc.update("DELETE FROM message_idempotency WHERE message_id = ANY(?)", (Object) ids);
        return jdbc.update("DELETE FROM messages WHERE id = ANY(?)", (Object) ids);
    }

    private static final RowMapper<StoredMessage> MESSAGE_MAPPER = (rs, rowNum) -> new StoredMessage(
            rs.getObject("id", UUID.class),
            rs.getObject("conversation_id", UUID.class),
            rs.getLong("seq"),
            rs.getObject("client_message_id", UUID.class),
            rs.getObject("sender_id", UUID.class),
            rs.getObject("sender_device_id", UUID.class),
            rs.getString("encoding"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("expires_at") == null ? null : rs.getTimestamp("expires_at").toInstant());
}
