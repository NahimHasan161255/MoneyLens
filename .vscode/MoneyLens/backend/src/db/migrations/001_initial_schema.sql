BEGIN;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users (id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (length(trim(slug)) > 0),
    CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX categories_default_slug_unique
    ON categories (slug)
    WHERE user_id IS NULL;

CREATE UNIQUE INDEX categories_user_slug_unique
    ON categories (user_id, slug)
    WHERE user_id IS NOT NULL;

INSERT INTO categories (slug, name)
VALUES
    ('food', 'Food'),
    ('shopping', 'Shopping'),
    ('transportation', 'Transportation'),
    ('bills', 'Bills'),
    ('entertainment', 'Entertainment'),
    ('health', 'Health'),
    ('travel', 'Travel'),
    ('other', 'Other');

CREATE TABLE oauth_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'google'),
    provider_subject TEXT NOT NULL,
    encrypted_refresh_token BYTEA NOT NULL,
    encryption_key_version TEXT NOT NULL,
    granted_scopes TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider),
    UNIQUE (provider, provider_subject)
);

CREATE TABLE processed_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    parser_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processed', 'failed')),
    error_code TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, gmail_message_id),
    UNIQUE (id, user_id),
    CHECK (length(trim(gmail_message_id)) > 0)
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    processed_email_id UUID NOT NULL,
    item_index INTEGER NOT NULL DEFAULT 0 CHECK (item_index >= 0),
    transaction_date DATE NOT NULL,
    transaction_time TIME WITHOUT TIME ZONE,
    merchant TEXT NOT NULL CHECK (length(trim(merchant)) > 0),
    amount NUMERIC(20, 6) NOT NULL CHECK (amount <> 0),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    category_id UUID REFERENCES categories (id) ON DELETE SET NULL,
    card_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (processed_email_id, user_id)
        REFERENCES processed_emails (id, user_id)
        ON DELETE CASCADE,
    UNIQUE (processed_email_id, item_index)
);

CREATE INDEX transactions_user_date_index
    ON transactions (user_id, transaction_date DESC, id);

CREATE INDEX transactions_user_category_index
    ON transactions (user_id, category_id, transaction_date DESC);

CREATE INDEX transactions_user_merchant_index
    ON transactions (user_id, merchant);

CREATE INDEX transactions_user_card_index
    ON transactions (user_id, card_name)
    WHERE card_name IS NOT NULL;

CREATE TABLE gmail_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    history_id TEXT,
    last_synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    error_code TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sync_runs_user_created_index
    ON sync_runs (user_id, created_at DESC);

COMMIT;
