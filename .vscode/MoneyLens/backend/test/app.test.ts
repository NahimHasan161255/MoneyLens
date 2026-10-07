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
