-- FR-3.14: disappearing messages. A per-conversation timer; every message sent while it is on
-- carries an absolute expiry, fixed at send time so changing the timer later never extends or
-- shortens what was already sent.

ALTER TABLE conversations
    ADD COLUMN disappearing_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages
    ADD COLUMN expires_at TIMESTAMPTZ;

-- The purge job's only access path. Partial: the vast majority of messages never expire.
CREATE INDEX idx_messages_expiry ON messages (expires_at) WHERE expires_at IS NOT NULL;
