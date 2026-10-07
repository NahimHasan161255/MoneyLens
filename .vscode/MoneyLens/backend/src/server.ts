import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { PostgresDatabase } from "./db/database.js";

const config = loadConfig();
const database = new PostgresDatabase(config.DATABASE_URL, config.DATABASE_SSL);
const app = createApp(database, {
  logger: { level: config.LOG_LEVEL },
  queryExecutor: database,
  environment: config.NODE_ENV,
  googleOAuth: config.googleOAuth
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");

  try {
    await app.close();
    await database.close();
  } catch (error) {
    app.log.error({ err: error }, "Failed to shut down cleanly");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const address = await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ address }, "MoneyLens API listening");
} catch (error) {
  app.log.error({ err: error }, "Failed to start MoneyLens API");
  await database.close();
  process.exitCode = 1;
}
