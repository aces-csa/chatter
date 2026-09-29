-- Step 13: media. Every blob is ciphertext the client encrypted before upload (requirement 11.8);
-- the server records who uploaded it, how big it is, and which conversations may fetch it --
-- never its type, name or dimensions, which travel inside the encrypted message.

CREATE TABLE media (
    id           UUID PRIMARY KEY,
    owner_id     UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    object_key   VARCHAR(256) NOT NULL,
    -- S3 multipart upload id while PENDING; null once the object is assembled.
    upload_id    VARCHAR(512),
    size_bytes   BIGINT       NOT NULL,
    part_size    INTEGER      NOT NULL,
    state        VARCHAR(16)  NOT NULL,   -- PENDING | UPLOADED
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_media_pending ON media (created_at) WHERE state = 'PENDING';

-- Which conversations a blob was shared into. Downloading requires active membership in one of
-- them, so leaving a chat also ends access to its media URLs.
CREATE TABLE media_links (
    media_id        UUID        NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    shared_by       UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (media_id, conversation_id)
);
CREATE INDEX idx_media_links_conversation ON media_links (conversation_id);
