import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { GoogleOAuthConfig } from "../src/config/env.js";
import type {
  DatabaseHealth,
  QueryExecutor,
  TransactionalQueryExecutor
} from "../src/db/database.js";
import { OAuthTokenCipher } from "../src/security/oauth-token-cipher.js";

const userId = "9c9eb6a5-9050-4469-a85b-f76d3fb2fc76";

function oauthConfig(): GoogleOAuthConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3001/v1/oauth/google/callback",
    encryptionKey: Buffer.alloc(32, 3),
    encryptionKeyVersion: "test-v1"
  };
}

function healthDatabase(): DatabaseHealth {
  return { async ping() {}, async close() {} };
}

function syncExecutor(connectionExists: boolean): TransactionalQueryExecutor {
  const executor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(`[{ "user_id": "${userId}" }]`) as Row[]
        };
      }
      if (text.includes("FROM oauth_connections")) {
        return {
          command: "SELECT",
          rowCount: connectionExists ? 1 : 0,
          oid: 0,
          fields: [],
          rows: connectionExists
            ? JSON.parse(`[{ "encrypted_refresh_token": [], "encryption_key_version": "test-v1" }]`) as Row[]
            : []
        };
      }
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    }
  };

  return {
    ...executor,
    async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>) {
      return operation(executor);
    }
  };
}

test("sync endpoint requires an authenticated app session", async (context) => {
  const app = createApp(healthDatabase(), {
    logger: false,
    transactionExecutor: syncExecutor(false),
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/sync",
    headers: { "content-type": "application/json" },
    payload: {}
  });

  assert.equal(response.statusCode, 401);
});

test("sync is disabled until Google OAuth configuration is complete", async (context) => {
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: syncExecutor(false),
    transactionExecutor: syncExecutor(false),
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/sync",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${"x".repeat(43)}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Google OAuth is not configured on this server."
  });
});

test("sync requires a Gmail account connection", async (context) => {
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: syncExecutor(false),
    transactionExecutor: syncExecutor(false),
    environment: "development",
    googleOAuth: oauthConfig()
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/sync",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${"x".repeat(43)}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "Connect a Gmail account before syncing."
  });
});

test("initial search persists a Japanese transaction once and history sync skips duplicates", async (context) => {
  const config = oauthConfig();
  const encryptedRefreshToken = new OAuthTokenCipher(
    config.encryptionKey,
    config.encryptionKeyVersion
  ).encrypt("stored-refresh-token");
  const processedMessages = new Set<string>();
  const requestValues: unknown[][] = [];
  let transactionCount = 0;
  let runCount = 0;
  let syncStateExists = false;

  const database: TransactionalQueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ) {
      requestValues.push([...(values ?? [])]);
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(`[{ "user_id": "${userId}" }]`) as Row[]
        };
      }
      if (text.includes("FROM oauth_connections")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [Object.assign(Object.create(null), {
            encrypted_refresh_token: encryptedRefreshToken.ciphertext,
            encryption_key_version: encryptedRefreshToken.keyVersion
          }) as Row]
        };
      }
      if (text.includes("FROM gmail_sync_state")) {
        return {
          command: "SELECT",
          rowCount: syncStateExists ? 1 : 0,
          oid: 0,
          fields: [],
          rows: syncStateExists
            ? JSON.parse('[{"history_id":"100","last_synced_at":"2026-10-07T00:00:00.000Z"}]') as Row[]
            : []
        };
      }
      if (text.includes("INSERT INTO sync_runs")) {
        runCount += 1;
        return { command: "INSERT", rowCount: 1, oid: 0, fields: [], rows: [] };
      }
      if (text.includes("INSERT INTO gmail_sync_state")) {
        syncStateExists = true;
        return { command: "INSERT", rowCount: 1, oid: 0, fields: [], rows: [] };
      }
      if (text.includes("UPDATE sync_runs SET status = 'completed'")) {
        return { command: "UPDATE", rowCount: 1, oid: 0, fields: [], rows: [] };
      }
      return { command: "UPDATE", rowCount: 1, oid: 0, fields: [], rows: [] };
    },
    async transaction<T>(operation: (transaction: QueryExecutor) => Promise<T>) {
      const transaction: QueryExecutor = {
        async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
          text: string,
          values?: readonly unknown[]
        ) {
          requestValues.push([...(values ?? [])]);
          if (text.includes("INSERT INTO processed_emails")) {
            const messageId = String(values?.[1]);
            if (processedMessages.has(messageId)) {
              return { command: "INSERT", rowCount: 0, oid: 0, fields: [], rows: [] };
            }
            processedMessages.add(messageId);
            return {
              command: "INSERT",
              rowCount: 1,
              oid: 0,
              fields: [],
              rows: JSON.parse('[{"id":"7a6412c2-e786-4709-9782-b37b987906e3"}]') as Row[]
            };
          }
          if (text.includes("INSERT INTO transactions")) {
            transactionCount += 1;
          }
          return { command: "UPDATE", rowCount: 1, oid: 0, fields: [], rows: [] };
        }
      };
      return operation(transaction);
    }
  };

  const gmailFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return new Response(JSON.stringify({
        access_token: "temporary-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/messages")) {
      assert.equal(url.searchParams.get("q"), "subject:ご利用");
      return new Response(JSON.stringify({ messages: [{ id: "card-message-1" }] }), { status: 200 });
    }
    if (url.pathname.endsWith("/history")) {
      return new Response(JSON.stringify({
        history: [{ messagesAdded: [{ message: { id: "card-message-1" } }] }]
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/messages/card-message-1")) {
      return new Response(JSON.stringify({
        id: "card-message-1",
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "ご利用日：2026年10月5日\nご利用先：Amazon.co.jp\nご利用金額：3,500円\nPRIVATE_RAW_EMAIL_TEXT"
            ).toString("base64url")
          },
          headers: [
            { name: "from", value: "notice@example-card.jp" },
            { name: "subject", value: "カードご利用のお知らせ" }
          ]
        }
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/profile")) {
      return new Response(JSON.stringify({ historyId: "101" }), { status: 200 });
    }
    throw new Error(`Unexpected Google API request: ${url.pathname}`);
  };
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: database,
    transactionExecutor: database,
    environment: "development",
    googleOAuth: config,
    gmailSearchQuery: "subject:ご利用",
    gmailMaxMessagesPerSync: 100,
    googleFetch: gmailFetch
  });
  context.after(() => app.close());

  const headers = { authorization: `Bearer ${"x".repeat(43)}` };
  const first = await app.inject({
    method: "POST",
    url: "/v1/sync",
    headers: { ...headers, "content-type": "application/json" },
    payload: {}
  });
  const firstResult = first.json<{
    addedCount: number;
    skippedCount: number;
    unsupportedCount: number;
    examinedCount: number;
  }>();
  const second = await app.inject({
    method: "POST",
    url: "/v1/sync",
    headers: { ...headers, "content-type": "application/json" },
    payload: {}
  });
  const secondResult = second.json<{
    addedCount: number;
    skippedCount: number;
    unsupportedCount: number;
    examinedCount: number;
  }>();

  assert.equal(first.statusCode, 200);
  assert.deepEqual(firstResult, {
    runId: first.json<{ runId: string }>().runId,
    status: "completed",
    addedCount: 1,
    skippedCount: 0,
    unsupportedCount: 0,
    examinedCount: 1,
    reconciled: false
  });
  assert.equal(second.statusCode, 200);
  assert.equal(secondResult.addedCount, 0);
  assert.equal(secondResult.skippedCount, 1);
  assert.equal(secondResult.unsupportedCount, 0);
  assert.equal(secondResult.examinedCount, 1);
  assert.equal(processedMessages.size, 1);
  assert.equal(transactionCount, 1);
  assert.equal(runCount, 2);
  assert.equal(
    requestValues.flat().some((value) => (
      typeof value === "string" && value.includes("PRIVATE_RAW_EMAIL_TEXT")
    )),
    false,
    "email content is parsed in memory and never written to the database"
  );
});
