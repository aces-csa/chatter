-- Sealed sender: 1:1 messages the server stores and routes without learning who sent them.

-- Each account's unidentified access key: 16 bytes the client derives from a secret profile key
-- and shares only inside end-to-end encrypted messages. Presenting it is what lets an anonymous
-- sender deliver, so only people the recipient has messaged can reach them this way. Rotated on
-- block, which pushes the blocked person back to identified sends the server can refuse.
CREATE TABLE unidentified_access (
    user_id    UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    access_key BYTEA       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per recipient device, deleted when that device acknowledges it. Note what is missing:
-- no sender, no conversation. The ciphertext is the sealed envelope, opaque to the server.
CREATE TABLE sealed_messages (
    id                  UUID PRIMARY KEY,
    recipient_user_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recipient_device_id UUID        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    ciphertext          BYTEA       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sealed_device ON sealed_messages (recipient_device_id, created_at);
CREATE INDEX idx_sealed_expiry ON sealed_messages (expires_at);
