import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { GoogleOAuthConfig } from "../src/config/env.js";
import type { DatabaseHealth, QueryExecutor } from "../src/db/database.js";
import { OAuthTokenCipher } from "../src/security/oauth-token-cipher.js";

const testUserId = "37ead7aa-8b11-4b64-bbdd-f36e6ca7a323";
const testKey = Buffer.alloc(32, 7);

function oauthConfig(): GoogleOAuthConfig {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:3001/v1/oauth/google/callback",
    encryptionKey: testKey,
    encryptionKeyVersion: "test-v1"
  };
}

function databaseWithSession(): QueryExecutor {
  return {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(`[{ "user_id": "${testUserId}" }]`) as Row[]
        };
      }
      return {
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: []
      };
    }
  };
}

function healthDatabase(): DatabaseHealth {
  return {
    async ping() {},
    async close() {}
  };
}

test("OAuth token cipher encrypts, authenticates, and identifies the key version", () => {
  const cipher = new OAuthTokenCipher(testKey, "test-v1");
  const first = cipher.encrypt("refresh-token-secret");
  const second = cipher.encrypt("refresh-token-secret");

  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes(Buffer.from("refresh-token-secret")), false);
  assert.equal(cipher.decrypt(first), "refresh-token-secret");
  assert.throws(() => cipher.decrypt({ ...first, keyVersion: "old-key" }), /unavailable key version/);

  const tampered = Buffer.from(first.ciphertext);
  const lastIndex = tampered.length - 1;
  tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 1;
  assert.throws(
    () => cipher.decrypt({ ...first, ciphertext: tampered }),
    /Unsupported state or unable to authenticate data/
  );
});

test("Gmail connect requires a session and reports missing server OAuth configuration", async (context) => {
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: databaseWithSession(),
    environment: "development"
  });
  context.after(() => app.close());

  const unauthorized = await app.inject({ method: "POST", url: "/v1/gmail/connect" });
  assert.equal(unauthorized.statusCode, 401);

  const unavailable = await app.inject({
    method: "POST",
    url: "/v1/gmail/connect",
    headers: { authorization: `Bearer ${"x".repeat(43)}` }
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), {
    error: "Google OAuth is not configured on this server."
  });
});

test("Gmail connect requests only read-only permission and uses one-time OAuth state", async (context) => {
  let insertedStateHash: Buffer | undefined;
  const database: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(`[{ "user_id": "${testUserId}" }]`) as Row[]
        };
      }
      if (text.includes("INSERT INTO google_oauth_flows")) {
        insertedStateHash = values?.[1] as Buffer;
      }
      return { command: "INSERT", rowCount: 1, oid: 0, fields: [], rows: [] };
    }
  };
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: database,
    environment: "development",
    googleOAuth: oauthConfig()
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/gmail/connect",
    headers: { authorization: `Bearer ${"x".repeat(43)}` }
  });
  const body = response.json<{ authorizationUrl: string; expiresIn: number }>();
  const authorizationUrl = new URL(body.authorizationUrl);

  assert.equal(response.statusCode, 201);
  assert.equal(body.expiresIn, 600);
  assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("state")?.length, 43);
  assert.ok(insertedStateHash);
  assert.equal(
    insertedStateHash?.equals(
      createHash("sha256")
        .update(authorizationUrl.searchParams.get("state")!)
        .digest()
    ),
    true
  );
});

test("OAuth callback exchanges the code and stores only an authenticated ciphertext", async (context) => {
  let stateHash: Buffer | undefined;
  let storedToken: Buffer | undefined;
  let flowConnected = false;
  const database: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ) {
      if (text.includes("UPDATE google_oauth_flows") && text.includes("RETURNING")) {
        stateHash = values?.[0] as Buffer;
        return {
          command: "UPDATE",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            `[{ "id": "34a9da45-19a5-4505-9737-7ef6e59c49ec", "user_id": "${testUserId}" }]`
          ) as Row[]
        };
      }
      if (text.includes("FROM oauth_connections")) {
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
      }
      if (text.includes("INSERT INTO oauth_connections")) {
        storedToken = values?.[2] as Buffer;
      }
      if (text.includes("SET status = 'connected'")) {
        flowConnected = true;
      }
      return { command: "UPDATE", rowCount: 1, oid: 0, fields: [], rows: [] };
    }
  };
  const fetchCalls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
        ? init.body.toString()
        : "";
    fetchCalls.push({
      url,
      authorization: headers.get("authorization"),
      body
    });

    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "short-lived-access-token",
        refresh_token: "long-lived-refresh-token",
        expires_in: 3600,
        token_type: "Bearer"
      }), { status: 200 });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return new Response(JSON.stringify({
        emailAddress: "test@example.com",
        historyId: "123456"
      }), { status: 200 });
    }
    throw new Error(`Unexpected Google URL: ${url}`);
  };

  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: database,
    environment: "development",
    googleOAuth: oauthConfig(),
    googleFetch: fetcher
  });
  context.after(() => app.close());

  const callback = await app.inject({
    method: "GET",
    url: `/v1/oauth/google/callback?code=one-time-code&state=${"s".repeat(43)}`
  });

  assert.equal(callback.statusCode, 200);
  assert.match(callback.body, /Gmail connected/);
  assert.equal(flowConnected, true);
  assert.ok(stateHash);
  assert.equal(
    stateHash?.equals(createHash("sha256").update("s".repeat(43)).digest()),
    true
  );
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0]?.body ?? "", /client_secret=test-client-secret/);
  assert.equal(fetchCalls[1]?.authorization, "Bearer short-lived-access-token");
  assert.ok(storedToken);
  assert.equal(storedToken?.includes(Buffer.from("long-lived-refresh-token")), false);
  assert.equal(
    new OAuthTokenCipher(testKey, "test-v1").decrypt({
      ciphertext: storedToken!,
      keyVersion: "test-v1"
    }),
    "long-lived-refresh-token"
  );
});

test("OAuth callback is public for Google redirects and rejects an unknown state", async (context) => {
  const app = createApp(healthDatabase(), {
    logger: false,
    queryExecutor: {
      async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
        text: string
      ) {
        assert.equal(text.includes("FROM app_sessions"), false);
        return { command: "UPDATE", rowCount: 0, oid: 0, fields: [], rows: [] as Row[] };
      }
    },
    environment: "development",
    googleOAuth: oauthConfig()
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/oauth/google/callback?code=example&state=${"x".repeat(43)}`
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.match(response.headers["referrer-policy"] ?? "", /no-referrer/);
  assert.doesNotMatch(response.body, /example/);
});
