import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { DatabaseHealth, QueryExecutor } from "../src/db/database.js";

function emptyQueryExecutor(): QueryExecutor {
  return {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>() {
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

test("root endpoint describes the API", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const app = createApp(database, { logger: false });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    name: "MoneyLens API",
    status: "ok",
    endpoints: {
      health: "/health",
      readiness: "/ready"
    }
  });
});

test("health endpoint is available without querying the database", async (context) => {
  let pingCount = 0;
  const database: DatabaseHealth = {
    async ping() {
      pingCount += 1;
    },
    async close() {}
  };
  const app = createApp(database, { logger: false });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(pingCount, 0);
});

test("readiness endpoint reports an available database", async (context) => {
  let pingCount = 0;
  const database: DatabaseHealth = {
    async ping() {
      pingCount += 1;
    },
    async close() {}
  };
  const app = createApp(database, { logger: false });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/ready" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready" });
  assert.equal(pingCount, 1);
});

test("readiness endpoint reports database failures without exposing details", async (context) => {
  const database: DatabaseHealth = {
    async ping() {
      throw new Error("private database connection detail");
    },
    async close() {}
  };
  const app = createApp(database, { logger: false });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/ready" });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: "unavailable" });
  assert.equal(response.body.includes("private database connection detail"), false);
});

test("user data endpoints reject requests without a valid session", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const app = createApp(database, {
    logger: false,
    queryExecutor: emptyQueryExecutor(),
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/dashboard" });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "Authentication required" });
});

test("session revocation requires an authenticated session", async (context) => {
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor: emptyQueryExecutor(),
    environment: "test"
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "DELETE", url: "/v1/session" });

  assert.equal(response.statusCode, 401);
});

test("session revocation only revokes the current user's presented token", async (context) => {
  let revokedValues: readonly unknown[] = [];
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            '[{"user_id":"37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"}]'
          ) as Row[]
        };
      }
      assert.match(text, /WHERE user_id = \$1 AND token_hash = \$2/);
      revokedValues = values;
      return {
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: []
      };
    }
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    environment: "test"
  });
  context.after(() => app.close());
  const token = "x".repeat(43);

  const response = await app.inject({
    method: "DELETE",
    url: "/v1/session",
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(response.statusCode, 204);
  assert.equal(revokedValues[0], "37ead7aa-8b11-4b64-bbdd-f36e6ca7a323");
  assert.equal(Buffer.isBuffer(revokedValues[1]), true);
  assert.equal((revokedValues[1] as Buffer).length, 32);
});

test("charts endpoint requires an authenticated session", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const app = createApp(database, {
    logger: false,
    queryExecutor: emptyQueryExecutor(),
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/charts?period=daily" });

  assert.equal(response.statusCode, 401);
});

test("charts endpoint rejects invalid periods and reversed date ranges", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            '[{"user_id":"37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"}]'
          ) as Row[]
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
  const app = createApp(database, {
    logger: false,
    queryExecutor,
    environment: "development"
  });
  context.after(() => app.close());
  const headers = { authorization: `Bearer ${"x".repeat(43)}` };

  const invalidPeriod = await app.inject({
    method: "GET",
    url: "/v1/charts?period=yearly",
    headers
  });
  const reversedDates = await app.inject({
    method: "GET",
    url: "/v1/charts?from=2026-10-10&to=2026-10-01",
    headers
  });

  assert.equal(invalidPeriod.statusCode, 400);
  assert.equal(reversedDates.statusCode, 400);
});

test("transaction export requires an authenticated session", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const app = createApp(database, {
    logger: false,
    queryExecutor: emptyQueryExecutor(),
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/transactions/export"
  });

  assert.equal(response.statusCode, 401);
});

test("transaction export is user-scoped and protects spreadsheet formula cells", async (context) => {
  let exportQuery = "";
  let exportValues: readonly unknown[] = [];
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            '[{"user_id":"37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"}]'
          ) as Row[]
        };
      }
      exportQuery = text;
      exportValues = values;
      return {
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: JSON.parse(
          '[{"transaction_date":"2026-10-05","transaction_time":null,'
            + '"merchant":"=HYPERLINK(\\"https://example.invalid\\")",'
            + '"amount":"3500.000000","currency":"JPY ",'
            + '"category_name":"Shopping","card_name":null}]'
        ) as Row[]
      };
    }
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    environment: "development"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: { authorization: `Bearer ${"x".repeat(43)}` }
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/csv/);
  assert.match(response.headers["content-disposition"] ?? "", /moneylens-transactions\.csv/);
  assert.equal(response.body.startsWith("\uFEFFdate,time,merchant,amount"), true);
  assert.match(response.body, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(response.body, /"3500\.000000","JPY","Shopping"/);
  assert.match(exportQuery, /WHERE t\.user_id = \$1/);
  assert.deepEqual(exportValues, ["37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"]);
});

test("delete all transactions requires a session and only deletes that user's records", async (context) => {
  let deleteQuery = "";
  let deleteValues: readonly unknown[] = [];
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            '[{"user_id":"37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"}]'
          ) as Row[]
        };
      }
      deleteQuery = text;
      deleteValues = values;
      return {
        command: "DELETE",
        rowCount: 3,
        oid: 0,
        fields: [],
        rows: []
      };
    }
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    environment: "development"
  });
  context.after(() => app.close());

  const unauthorizedResponse = await app.inject({
    method: "DELETE",
    url: "/v1/transactions"
  });
  const response = await app.inject({
    method: "DELETE",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${"x".repeat(43)}` }
  });

  assert.equal(unauthorizedResponse.statusCode, 401);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deletedCount: 3 });
  assert.match(deleteQuery, /^DELETE FROM transactions WHERE user_id = \$1$/);
  assert.deepEqual(deleteValues, ["37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"]);
});

test("account deletion requires a session and deletes only the authenticated account", async (context) => {
  const statements: string[] = [];
  let accountDeleteValues: readonly unknown[] = [];
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      statements.push(text);
      if (text.includes("FROM app_sessions")) {
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: JSON.parse(
            '[{"user_id":"37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"}]'
          ) as Row[]
        };
      }
      if (text.includes("FROM oauth_connections")) {
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
      }
      accountDeleteValues = values;
      return { command: "DELETE", rowCount: 1, oid: 0, fields: [], rows: [] };
    }
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    environment: "test"
  });
  context.after(() => app.close());

  const unauthenticated = await app.inject({ method: "DELETE", url: "/v1/account" });
  const response = await app.inject({
    method: "DELETE",
    url: "/v1/account",
    headers: { authorization: `Bearer ${"x".repeat(43)}` }
  });

  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    deleted: true,
    googleRevocation: "not_connected"
  });
  assert.match(statements.at(-1) ?? "", /^DELETE FROM users WHERE id = \$1$/);
  assert.deepEqual(accountDeleteValues, ["37ead7aa-8b11-4b64-bbdd-f36e6ca7a323"]);
});

test("development session endpoint is unavailable outside development", async (context) => {
  const database: DatabaseHealth = {
    async ping() {},
    async close() {}
  };
  const app = createApp(database, {
    logger: false,
    queryExecutor: emptyQueryExecutor(),
    environment: "production"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/dev/session",
    headers: { "content-type": "application/json" },
    payload: {}
  });

  assert.equal(response.statusCode, 404);
});
