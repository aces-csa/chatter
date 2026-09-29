-- Step 15: Web Push (FR-8.1). One subscription per browser install, owned by its device, so
-- revoking a device or deleting the account removes its push endpoint too.
CREATE TABLE push_subscriptions (
    id         UUID PRIMARY KEY,
    device_id  UUID        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    endpoint   TEXT        NOT NULL UNIQUE,
    p256dh     TEXT        NOT NULL,
    auth       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_push_device ON push_subscriptions (device_id);

-- The VAPID key pair identifies this server to push services. Every subscription is bound to
-- its public key, so it must survive restarts and be shared by every app instance: generated
-- once on first boot and kept here. Single row by construction.
CREATE TABLE vapid_keys (
    id          SMALLINT PRIMARY KEY CHECK (id = 1),
    public_key  BYTEA       NOT NULL,
    private_key BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
