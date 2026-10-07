BEGIN;

ALTER TABLE users
    ADD COLUMN auth_subject TEXT UNIQUE;

CREATE TABLE app_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX app_sessions_active_token_index
    ON app_sessions (token_hash, expires_at)
    WHERE revoked_at IS NULL;

COMMIT;
