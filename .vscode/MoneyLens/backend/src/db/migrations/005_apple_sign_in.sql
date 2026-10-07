BEGIN;

CREATE TABLE apple_sign_in_nonces (
    nonce_hash BYTEA PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX apple_sign_in_nonces_expiry_index
    ON apple_sign_in_nonces (expires_at);

COMMIT;
