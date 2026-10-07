import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { DatabaseHealth } from "../src/db/database.js";

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
