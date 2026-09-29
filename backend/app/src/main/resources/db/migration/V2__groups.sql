-- Step 11: groups, sender keys, invite links.

-- Group settings. Two booleans rather than the JSONB blob sketched in the LLD: there are exactly
-- two flags, both are read on the hot path (every group send checks onlyAdminsCanPost), and
-- typed columns keep JPA validation honest.
ALTER TABLE conversations
    ADD COLUMN only_admins_can_post      BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN only_admins_can_edit_info BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE group_invites (
    code            VARCHAR(32) PRIMARY KEY,
    conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    created_by      UUID        NOT NULL REFERENCES users (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked         BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX idx_invites_conversation ON group_invites (conversation_id) WHERE revoked = false;

-- A group message under sender keys is ONE ciphertext every member device can open (LLD 3.6,
-- DD-4): written once here, not copied per recipient. Server-authored system events use the same
-- slot with encoding 'system/v1', holding plaintext JSON the server wrote itself.
CREATE TABLE message_group_payloads (
    message_id UUID PRIMARY KEY,
    ciphertext BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- message_payloads rows stay one-per-recipient-device -- they are the delivery pointer that sync
-- reads -- but for a group message most carry no pairwise ciphertext at all. Only devices that
-- are being handed the sender key for the first time get one.
ALTER TABLE message_payloads ALTER COLUMN ciphertext DROP NOT NULL;
