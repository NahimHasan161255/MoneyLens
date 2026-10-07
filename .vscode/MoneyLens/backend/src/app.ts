import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyLoggerOptions } from "fastify";

import type { GoogleOAuthConfig } from "./config/env.js";
import type { DatabaseHealth, QueryExecutor } from "./db/database.js";
import { registerGoogleOAuthRoutes } from "./auth/google-oauth-routes.js";
import { registerUserRoutes } from "./transactions/routes.js";

export function createApp(
  database: DatabaseHealth,
  options: {
    logger?: boolean | FastifyLoggerOptions;
    queryExecutor?: QueryExecutor;
    environment?: "development" | "test" | "production";
    googleOAuth?: GoogleOAuthConfig | null;
    googleFetch?: typeof fetch;
  } = {}
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.get("/", async () => ({
    name: "MoneyLens API",
    status: "ok",
    endpoints: {
      health: "/health",
      readiness: "/ready"
    }
  }));

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (request, reply) => {
    try {
      await database.ping();
      return { status: "ready" };
    } catch (error) {
      request.log.error({ err: error }, "Database readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  if (options.queryExecutor) {
    registerUserRoutes(app, options.queryExecutor, options.environment ?? "production");
    registerGoogleOAuthRoutes(
      app,
      options.queryExecutor,
      options.googleOAuth ?? null,
      options.googleFetch ?? fetch
    );
  }

  return app;
}
