-- Profile photos, privacy enforcement, per-member chat state, message info, quiet hours.

-- Small JPEG as a data URL (<= ~100 KB). Profile photos are not end-to-end encrypted -- as on
-- WhatsApp they are profile metadata -- but who may see one is governed by user_privacy.
ALTER TABLE users ADD COLUMN avatar_data TEXT;

-- Quiet hours (FR-8.4): minutes after local midnight, in the user's own time zone.
ALTER TABLE user_privacy
    ADD COLUMN quiet_start SMALLINT,
    ADD COLUMN quiet_end   SMALLINT,
    ADD COLUMN time_zone   VARCHAR(64);

-- Every user gets a privacy row, so reads never have to guess defaults.
INSERT INTO user_privacy (user_id) SELECT id FROM users ON CONFLICT DO NOTHING;

-- FR-7.3 "mark as unread": a flag rather than a fake unread count, cleared by the next read.
ALTER TABLE conversation_members ADD COLUMN marked_unread BOOLEAN NOT NULL DEFAULT false;

-- FR-4.8 message info: when each recipient's devices first had and first read the message.
ALTER TABLE inbox
    ADD COLUMN delivered_at TIMESTAMPTZ,
    ADD COLUMN read_at      TIMESTAMPTZ;
