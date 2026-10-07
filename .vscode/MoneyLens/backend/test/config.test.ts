import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config/env.js";

test("configuration applies safe development defaults", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/moneylens"
  });

  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.PORT, 3000);
  assert.equal(config.DATABASE_SSL, false);
});

test("production configuration requires PostgreSQL TLS", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:secret@db.example.com/moneylens",
        DATABASE_SSL: "false"
      }),
    /DATABASE_SSL must be true in production/
  );
});

test("configuration rejects non-PostgreSQL database URLs", () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: "https://db.example.com/moneylens" }),
    /DATABASE_URL must use the postgres or postgresql protocol/
  );
});

test("empty Google OAuth template values leave Gmail connection disabled", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/moneylens",
    GOOGLE_OAUTH_CLIENT_ID: "",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_REDIRECT_URI: "",
    GOOGLE_OAUTH_ENCRYPTION_KEY: "",
    GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION: ""
  });

  assert.equal(config.googleOAuth, null);
});

test("configuration rejects a partially configured Google OAuth connection", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/moneylens",
        GOOGLE_OAUTH_CLIENT_ID: "client-id"
      }),
    /Google OAuth client, callback, and token-encryption settings must be configured together/
  );
});

test("configuration rejects insecure non-local OAuth callback URLs outside development", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/moneylens",
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "http://api.example.com/oauth/callback",
        GOOGLE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
        GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION: "test-v1"
      }),
    /Google OAuth callback URI must use HTTPS outside development/
  );
});
