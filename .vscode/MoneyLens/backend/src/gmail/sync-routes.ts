import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { GoogleOAuthConfig } from "../config/env.js";
import type { QueryExecutor, TransactionalQueryExecutor } from "../db/database.js";
import { GmailApiError, GmailClient } from "./gmail-client.js";
import { OAuthTokenCipher } from "../security/oauth-token-cipher.js";
import { defaultEmailParserRegistry } from "../parser/registry.js";
import type { ParsedTransaction } from "../parser/types.js";

interface GoogleConnectionRow {
  encrypted_refresh_token: Buffer;
  encryption_key_version: string;
}

interface SyncStateRow {
  history_id: string | null;
  last_synced_at: Date | null;
}

interface SyncRunRow {
  id: string;
  status: string;
  added_count: number;
  skipped_count: number;
  error_code: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

interface ProcessResult {
  insertedTransactions: number;
  duplicate: boolean;
  unsupported: boolean;
}

const syncRunIdSchema = z.string().uuid();
const oauthStateLifetimeDays = 7;

function missingAuthentication(reply: {
  code(statusCode: number): { send(payload: unknown): unknown };
}): unknown {
  return reply.code(401).send({ error: "Authentication required" });
}

export function registerGmailSyncRoutes(
  app: FastifyInstance,
  database: TransactionalQueryExecutor,
  googleOAuth: GoogleOAuthConfig | null,
  searchQuery: string,
  maxMessages: number,
  fetcher: typeof fetch = fetch
): void {
  const cipher = googleOAuth
    ? new OAuthTokenCipher(googleOAuth.encryptionKey, googleOAuth.encryptionKeyVersion)
    : null;

  app.post("/v1/sync", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return missingAuthentication(reply);
    }
    if (!googleOAuth || !cipher) {
      return reply.code(503).send({
        error: "Google OAuth is not configured on this server."
      });
    }

    const connection = await database.query<GoogleConnectionRow>(
      `SELECT encrypted_refresh_token, encryption_key_version
       FROM oauth_connections
       WHERE user_id = $1 AND provider = 'google'`,
      [userId]
    );
    const storedConnection = connection.rows[0];
    if (!storedConnection) {
      return reply.code(409).send({ error: "Connect a Gmail account before syncing." });
    }

    const runId = randomUUID();
    try {
      await database.query(
        `UPDATE sync_runs
         SET status = 'failed', error_code = 'sync_timeout', completed_at = now()
         WHERE user_id = $1
           AND status IN ('pending', 'running')
           AND created_at < now() - interval '30 minutes'`,
        [userId]
      );
      await database.query(
        `INSERT INTO sync_runs (id, user_id, status, started_at)
         VALUES ($1, $2, 'running', now())`,
        [runId, userId]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "A Gmail sync is already in progress." });
      }
      throw error;
    }

    try {
      const refreshToken = cipher.decrypt({
        ciphertext: storedConnection.encrypted_refresh_token,
        keyVersion: storedConnection.encryption_key_version
      });
      const gmail = new GmailClient(
        refreshToken,
        googleOAuth.clientId,
        googleOAuth.clientSecret,
        fetcher
      );
      const syncState = await database.query<SyncStateRow>(
        `SELECT history_id, last_synced_at
         FROM gmail_sync_state
         WHERE user_id = $1`,
        [userId]
      );
      const currentState = syncState.rows[0];
      let messageIds: string[];
      let reconciled = false;

      if (currentState?.last_synced_at && currentState.history_id) {
        try {
          messageIds = await gmail.listNewMessageIds(currentState.history_id, maxMessages);
        } catch (error) {
          if (!(error instanceof GmailApiError) || error.statusCode !== 404) {
            throw error;
          }
          request.log.warn({ userId }, "Gmail history expired; running a reconciliation search");
          messageIds = await gmail.listMessageIds(searchQuery, maxMessages);
          reconciled = true;
        }
      } else {
        messageIds = await gmail.listMessageIds(searchQuery, maxMessages);
      }

      let addedCount = 0;
      let skippedCount = 0;
      let unsupportedCount = 0;
      let examinedCount = 0;

      const results = await mapConcurrent(messageIds, 5, async (messageId) => {
        const message = await gmail.message(messageId);
        if (!message) {
          return { added: 0, skipped: 1, unsupported: 0, examined: 0 };
        }

        const parsed = defaultEmailParserRegistry.parse(message.parserInput);
        const result = await persistMessage(
          database,
          userId,
          message.id,
          parsed.status === "parsed" ? parsed.parserKey : null,
          parsed.status === "parsed" ? parsed.transactions : [],
          parsed.status === "unsupported" ? parsed.reason : null
        );

        return {
          added: result.insertedTransactions,
          skipped: result.duplicate || result.insertedTransactions === 0 ? 1 : 0,
          unsupported: result.unsupported ? 1 : 0,
          examined: 1
        };
      });
      addedCount = results.reduce((count, result) => count + result.added, 0);
      skippedCount = results.reduce((count, result) => count + result.skipped, 0);
      unsupportedCount = results.reduce((count, result) => count + result.unsupported, 0);
      examinedCount = results.reduce((count, result) => count + result.examined, 0);

      const historyId = await gmail.latestHistoryId();
      await database.query(
        `INSERT INTO gmail_sync_state (user_id, history_id, last_synced_at, updated_at)
         VALUES ($1, $2, now(), now())
         ON CONFLICT (user_id)
         DO UPDATE SET
           history_id = EXCLUDED.history_id,
           last_synced_at = EXCLUDED.last_synced_at,
           updated_at = now()`,
        [userId, historyId]
      );
      await database.query(
        `UPDATE sync_runs
         SET status = 'completed', added_count = $2, skipped_count = $3, completed_at = now()
         WHERE id = $1 AND user_id = $4`,
        [runId, addedCount, skippedCount, userId]
      );

      return {
        runId,
        status: "completed",
        addedCount,
        skippedCount,
        unsupportedCount,
        examinedCount,
        reconciled
      };
    } catch (error) {
      const errorCode = errorCodeFor(error);
      await database.query(
        `UPDATE sync_runs
         SET status = 'failed', error_code = $2, completed_at = now()
         WHERE id = $1 AND user_id = $3`,
        [runId, errorCode, userId]
      );
      request.log.error({ err: error, runId, userId }, "Gmail sync failed");
      return reply.code(502).send({
        runId,
        status: "failed",
        error: "Gmail sync failed. Check the connection and try again."
      });
    }
  });

  app.get<{ Params: { runId: string } }>("/v1/sync/:runId", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return missingAuthentication(reply);
    }
    if (!syncRunIdSchema.safeParse(request.params.runId).success) {
      return reply.code(400).send({ error: "Invalid sync run ID" });
    }

    const result = await database.query<SyncRunRow>(
      `SELECT id, status, added_count, skipped_count, error_code, started_at, completed_at
       FROM sync_runs
       WHERE id = $1 AND user_id = $2`,
      [request.params.runId, userId]
    );
    const run = result.rows[0];
    if (!run) {
      return reply.code(404).send({ error: "Sync run not found" });
    }

    return {
      runId: run.id,
      status: run.status,
      addedCount: run.added_count,
      skippedCount: run.skipped_count,
      errorCode: run.error_code,
      startedAt: run.started_at,
      completedAt: run.completed_at
    };
  });
}

async function persistMessage(
  database: TransactionalQueryExecutor,
  userId: string,
  messageId: string,
  parserKey: string | null,
  transactions: ParsedTransaction[],
  errorCode: string | null
): Promise<ProcessResult> {
  return database.transaction(async (transaction) => {
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO processed_emails (user_id, gmail_message_id, parser_key, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (user_id, gmail_message_id) DO NOTHING
       RETURNING id`,
      [userId, messageId, parserKey]
    );

    const retry = inserted.rows[0]
      ? null
      : await transaction.query<{ id: string }>(
          `UPDATE processed_emails
           SET status = 'pending', parser_key = $3, error_code = NULL,
               created_at = now(), processed_at = NULL
           WHERE user_id = $1
             AND gmail_message_id = $2
             AND (
               status = 'failed'
               OR (status = 'pending' AND created_at < now() - interval '10 minutes')
             )
           RETURNING id`,
          [userId, messageId, parserKey]
        );
    const emailId = inserted.rows[0]?.id ?? retry?.rows[0]?.id;

    if (!emailId) {
      return { insertedTransactions: 0, duplicate: true, unsupported: false };
    }

    if (transactions.length === 0) {
      await transaction.query(
        `UPDATE processed_emails
         SET status = 'failed', error_code = $2, processed_at = now()
         WHERE id = $1 AND user_id = $3`,
        [emailId, errorCode ?? "parser_returned_no_transactions", userId]
      );
      return { insertedTransactions: 0, duplicate: false, unsupported: true };
    }

    for (const [itemIndex, candidate] of transactions.entries()) {
      await transaction.query(
        `INSERT INTO transactions (
           user_id, processed_email_id, item_index, transaction_date, transaction_time,
           merchant, amount, currency, category_id, card_name
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, category.id, $9
         FROM categories category
         WHERE category.slug = $10 AND category.user_id IS NULL
         ON CONFLICT (processed_email_id, item_index) DO NOTHING`,
        [
          userId,
          emailId,
          itemIndex,
          candidate.date,
          candidate.time,
          candidate.merchant,
          candidate.amount,
          candidate.currency,
          candidate.cardName,
          candidate.category
        ]
      );
    }

    await transaction.query(
      `UPDATE processed_emails
       SET status = 'processed', error_code = NULL, processed_at = now()
       WHERE id = $1 AND user_id = $2`,
      [emailId, userId]
    );

    return {
      insertedTransactions: transactions.length,
      duplicate: false,
      unsupported: false
    };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}

function errorCodeFor(error: unknown): string {
  if (error instanceof GmailApiError) {
    return error.statusCode === 401
      ? "google_authorization_failed"
      : `gmail_api_${error.statusCode}`;
  }
  return "sync_failed";
}

async function mapConcurrent<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await operation(value);
    }
  };

  const workerResults = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  const failedWorker = workerResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failedWorker) {
    throw failedWorker.reason;
  }
  return results;
}
