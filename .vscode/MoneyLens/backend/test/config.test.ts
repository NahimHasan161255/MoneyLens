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
