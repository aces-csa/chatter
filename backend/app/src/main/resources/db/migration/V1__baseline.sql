-- Chatter baseline schema (LLD section 4).
-- The server stores ciphertext and routing metadata only; it cannot read message content.

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    phone_e164      VARCHAR(20)  NOT NULL UNIQUE,
    phone_hash      BYTEA        NOT NULL,
    display_name    VARCHAR(64)  NOT NULL,
    about           VARCHAR(160) NOT NULL DEFAULT 'Hey there! I am using Chatter.',
    avatar_media_id UUID,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_phone_hash ON users (phone_hash);

CREATE TABLE user_privacy (
    user_id          UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    last_seen        VARCHAR(16) NOT NULL DEFAULT 'everyone',
    profile_photo    VARCHAR(16) NOT NULL DEFAULT 'everyone',
    about_visibility VARCHAR(16) NOT NULL DEFAULT 'everyone',
    read_receipts    BOOLEAN     NOT NULL DEFAULT true,
    groups_policy    VARCHAR(16) NOT NULL DEFAULT 'everyone'
);

CREATE TABLE devices (
    id              UUID PRIMARY KEY,
    user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            VARCHAR(64),
    platform        VARCHAR(32),
    is_primary      BOOLEAN     NOT NULL DEFAULT false,
    -- Signal public identity. Null until the client completes key registration.
    identity_key    BYTEA,
    registration_id INTEGER,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_user ON devices (user_id);

CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY,
    device_id  UUID        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    family_id  UUID        NOT NULL,
    token_hash BYTEA       NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);

-- ------------------------------------------------------------ social graph
CREATE TABLE contacts (
    owner_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    contact_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    alias      VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id)
);

CREATE TABLE blocks (
    blocker_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

-- ----------------------------------------------------------- conversations
CREATE TABLE conversations (
    id              UUID PRIMARY KEY,
    type            VARCHAR(8)  NOT NULL,
    subject         VARCHAR(100),
    description     VARCHAR(512),
    avatar_media_id UUID,
    created_by      UUID REFERENCES users (id),
    -- DIRECT only: "minUuid:maxUuid". The unique constraint is what stops two clients
    -- racing to open the same chat from creating two conversations.
    pair_key        VARCHAR(73) UNIQUE,
    last_seq        BIGINT      NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_last_msg ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
    conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role            VARCHAR(8)  NOT NULL DEFAULT 'MEMBER',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at         TIMESTAMPTZ,
    muted_until     TIMESTAMPTZ,
    pinned          BOOLEAN     NOT NULL DEFAULT false,
    archived        BOOLEAN     NOT NULL DEFAULT false,
    last_read_seq   BIGINT      NOT NULL DEFAULT 0,
    unread_count    INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_member_user ON conversation_members (user_id) WHERE left_at IS NULL;

-- ------------------------------------------- Signal key material (public halves only)
CREATE TABLE signed_prekeys (
    device_id  UUID        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    key_id     INTEGER     NOT NULL,
    public_key BYTEA       NOT NULL,
    signature  BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, key_id)
);

CREATE TABLE one_time_prekeys (
    device_id   UUID    NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    key_id      INTEGER NOT NULL,
    public_key  BYTEA   NOT NULL,
    consumed_at TIMESTAMPTZ,
    PRIMARY KEY (device_id, key_id)
);
CREATE INDEX idx_otpk_available ON one_time_prekeys (device_id, key_id) WHERE consumed_at IS NULL;

-- --------------------------------------------------------------- messages
-- Metadata only. Content lives in message_payloads as opaque ciphertext.
CREATE TABLE messages (
    conversation_id   UUID        NOT NULL,
    seq               BIGINT      NOT NULL,
    id                UUID        NOT NULL,
    client_message_id UUID        NOT NULL,
    sender_id         UUID        NOT NULL,
    sender_device_id  UUID        NOT NULL,
    encoding          VARCHAR(16) NOT NULL DEFAULT 'signal/v3',
    edited_at         TIMESTAMPTZ,
    deleted_for_all   BOOLEAN     NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_msg_id ON messages (id);

-- Twelve months ahead plus a catch-all, so a missing partition can never reject a write.
DO $$
    DECLARE
        start_month DATE := date_trunc('month', now())::date;
        m           INTEGER;
        lo          DATE;
        hi          DATE;
    BEGIN
        FOR m IN -1..12
            LOOP
                lo := (start_month + (m || ' month')::interval)::date;
                hi := (start_month + ((m + 1) || ' month')::interval)::date;
                EXECUTE format(
                        'CREATE TABLE IF NOT EXISTS messages_%s PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
                        to_char(lo, 'YYYYMM'), lo, hi);
            END LOOP;
    END
$$;
CREATE TABLE messages_default PARTITION OF messages DEFAULT;

-- A unique index on a partitioned table must contain the partition key, which would defeat the
-- purpose here. Idempotency therefore gets its own small unpartitioned table -- this is the
-- durable backstop behind the Redis fast path (LLD DD-5).
CREATE TABLE message_idempotency (
    sender_device_id  UUID        NOT NULL,
    client_message_id UUID        NOT NULL,
    message_id        UUID        NOT NULL,
    conversation_id   UUID        NOT NULL,
    seq               BIGINT      NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sender_device_id, client_message_id)
);

-- One opaque ciphertext per recipient device (LLD 3.6).
CREATE TABLE message_payloads (
    message_id          UUID        NOT NULL,
    recipient_device_id UUID        NOT NULL,
    recipient_user_id   UUID        NOT NULL,
    conversation_id     UUID        NOT NULL,
    seq                 BIGINT      NOT NULL,
    cipher_type         SMALLINT    NOT NULL,
    ciphertext          BYTEA       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, recipient_device_id)
);
CREATE INDEX idx_payload_device_seq ON message_payloads (recipient_device_id, conversation_id, seq);

-- Per-recipient pointer. 0 undelivered, 1 delivered, 2 read.
CREATE TABLE inbox (
    user_id         UUID        NOT NULL,
    conversation_id UUID        NOT NULL,
    seq             BIGINT      NOT NULL,
    state           SMALLINT    NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id, seq)
);
CREATE INDEX idx_inbox_undelivered ON inbox (user_id) WHERE state = 0;

-- ---------------------------------------------------- transactional outbox
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,
    aggregate_id  UUID        NOT NULL,
    topic         VARCHAR(64) NOT NULL,
    partition_key VARCHAR(64) NOT NULL,
    payload       TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
