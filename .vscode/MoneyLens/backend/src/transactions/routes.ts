import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { QueryExecutor } from "../db/database.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
}

const idSchema = z.string().uuid();
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  });

const listQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    categoryId: idSchema.optional(),
    merchant: z.string().trim().min(1).max(200).optional(),
    cardName: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100_000).default(0)
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "'from' must be on or before 'to'"
  });

const categoryUpdateSchema = z.object({
  categoryId: idSchema.nullable()
});

const chartQuerySchema = z.object({
  period: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  from: dateSchema.optional(),
  to: dateSchema.optional()
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: "'from' must be on or before 'to'"
});

interface SessionRow {
  user_id: string;
}

interface TransactionRow {
  id: string;
  transaction_date: string;
  transaction_time: string | null;
  merchant: string;
  amount: string;
  currency: string;
  category_id: string | null;
  category_name: string | null;
  card_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SummaryRow {
  currency: string;
  today: string;
  last_7_days: string;
  last_14_days: string;
  last_30_days: string;
  this_month: string;
  last_month: string;
}

const sessionLifetimeDays = 7;
const developmentSubject = "moneylens-local-development";

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
  return match?.[1] ?? null;
}

function unauthorized(reply: {
  code(statusCode: number): { send(payload: unknown): unknown };
}): unknown {
  return reply.code(401).send({ error: "Authentication required" });
}

function badRequest(reply: {
  code(statusCode: number): { send(payload: unknown): unknown };
}, message: string): unknown {
  return reply.code(400).send({ error: message });
}

function transactionResponse(row: TransactionRow) {
  return {
    id: row.id,
    date: row.transaction_date,
    time: row.transaction_time,
    merchant: row.merchant,
    amount: row.amount,
    currency: row.currency.trim(),
    category: row.category_name ?? "Other",
    categoryId: row.category_id,
    cardName: row.card_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function csvCell(value: string | null, protectSpreadsheetFormula = true): string {
  const safeValue = value ?? "";
  const spreadsheetSafeValue = protectSpreadsheetFormula && /^[\t\r ]*[=+\-@]/.test(safeValue)
    ? `'${safeValue}`
    : safeValue;
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}

export function registerUserRoutes(
  app: FastifyInstance,
  database: QueryExecutor,
  environment: "development" | "test" | "production"
): void {
  app.decorateRequest("userId", null);

  app.post("/v1/dev/session", async (_request, reply) => {
    if (environment !== "development") {
      return reply.code(404).send({ error: "Not found" });
    }

    const user = await database.query<{ id: string }>(
      `INSERT INTO users (auth_subject)
       VALUES ($1)
       ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [developmentSubject]
    );
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);

    await database.query(
      `INSERT INTO app_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
      [user.rows[0]!.id, tokenHash, sessionLifetimeDays]
    );

    return reply.code(201).send({
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: sessionLifetimeDays * 24 * 60 * 60
    });
  });

  app.delete("/v1/session", async (request, reply) => {
    const userId = request.userId;
    const token = bearerToken(request);
    if (!userId || !token) {
      return unauthorized(reply);
    }
    await database.query(
      `UPDATE app_sessions
       SET revoked_at = now()
       WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
      [userId, hashToken(token)]
    );
    return reply.code(204).send();
  });

  app.addHook("preHandler", async (request, reply) => {
    if (
      !request.routeOptions.url?.startsWith("/v1/")
      || request.routeOptions.url === "/v1/dev/session"
      || request.routeOptions.url === "/v1/oauth/google/callback"
      || request.routeOptions.url === "/v1/auth/apple/nonce"
      || request.routeOptions.url === "/v1/auth/apple"
    ) {
      return;
    }

    const token = bearerToken(request);
    if (!token) {
      return unauthorized(reply);
    }

    const session = await database.query<SessionRow>(
      `SELECT user_id
       FROM app_sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [hashToken(token)]
    );

    const userId = session.rows[0]?.user_id;
    if (!userId) {
      return unauthorized(reply);
    }

    request.userId = userId;
  });

  app.get("/v1/categories", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const result = await database.query<{
      id: string;
      slug: string;
      name: string;
      user_id: string | null;
    }>(
      `SELECT id, slug, name, user_id
       FROM categories
       WHERE user_id IS NULL OR user_id = $1
       ORDER BY user_id NULLS FIRST, name`,
      [userId]
    );

    return {
      items: result.rows.map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        isDefault: category.user_id === null
      }))
    };
  });

  app.get("/v1/dashboard", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const result = await database.query<SummaryRow>(
      `WITH local_date AS (
         SELECT (now() AT TIME ZONE timezone)::date AS today
         FROM users
         WHERE id = $1
       )
       SELECT
         t.currency,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date = local_date.today
         ), 0)::text AS today,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date BETWEEN local_date.today - 6 AND local_date.today
         ), 0)::text AS last_7_days,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date BETWEEN local_date.today - 13 AND local_date.today
         ), 0)::text AS last_14_days,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date BETWEEN local_date.today - 29 AND local_date.today
         ), 0)::text AS last_30_days,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date >= date_trunc('month', local_date.today)::date
         ), 0)::text AS this_month,
         COALESCE(sum(t.amount) FILTER (
           WHERE t.transaction_date >= (date_trunc('month', local_date.today) - interval '1 month')::date
             AND t.transaction_date < date_trunc('month', local_date.today)::date
         ), 0)::text AS last_month
       FROM local_date
       JOIN transactions t
         ON t.user_id = $1
        AND t.transaction_date <= local_date.today
       GROUP BY t.currency
       ORDER BY t.currency`,
      [userId]
    );

    return {
      timezone: (
        await database.query<{ timezone: string }>(
          "SELECT timezone FROM users WHERE id = $1",
          [userId]
        )
      ).rows[0]?.timezone,
      currencies: result.rows.map((row) => ({
        currency: row.currency.trim(),
        today: row.today,
        last7Days: row.last_7_days,
        last14Days: row.last_14_days,
        last30Days: row.last_30_days,
        thisMonth: row.this_month,
        lastMonth: row.last_month
      }))
    };
  });

  app.get("/v1/charts", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const parsedQuery = chartQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return badRequest(reply, parsedQuery.error.issues[0]?.message ?? "Invalid chart parameters");
    }

    const { period, from, to } = parsedQuery.data;
    const periodExpression = {
      daily: "t.transaction_date",
      weekly: "date_trunc('week', t.transaction_date::timestamp)::date",
      monthly: "date_trunc('month', t.transaction_date::timestamp)::date"
    }[period];
    const range = await database.query<{ from_date: string; to_date: string }>(
      `SELECT
         COALESCE($2::date, (now() AT TIME ZONE u.timezone)::date - 29)::text AS from_date,
         COALESCE($3::date, (now() AT TIME ZONE u.timezone)::date)::text AS to_date
       FROM users u
       WHERE u.id = $1`,
      [userId, from ?? null, to ?? null]
    );
    const chartRange = range.rows[0];
    if (!chartRange) {
      return reply.code(404).send({ error: "Account not found" });
    }

    const [series, categories] = await Promise.all([
      database.query<{
        period_start: string;
        currency: string;
        amount: string;
      }>(
        `SELECT ${periodExpression}::text AS period_start,
                t.currency, sum(t.amount)::text AS amount
         FROM transactions t
         WHERE t.user_id = $1
           AND t.transaction_date BETWEEN $2::date AND $3::date
         GROUP BY period_start, t.currency
         ORDER BY period_start, t.currency`,
        [userId, chartRange.from_date, chartRange.to_date]
      ),
      database.query<{
        category_id: string | null;
        category_name: string | null;
        currency: string;
        amount: string;
      }>(
        `SELECT t.category_id,
                c.name AS category_name,
                t.currency, sum(t.amount)::text AS amount
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id
          AND (c.user_id IS NULL OR c.user_id = t.user_id)
         WHERE t.user_id = $1
           AND t.transaction_date BETWEEN $2::date AND $3::date
         GROUP BY t.category_id, c.name, t.currency
         ORDER BY t.currency, amount DESC`,
        [userId, chartRange.from_date, chartRange.to_date]
      )
    ]);

    return {
      period,
      from: chartRange.from_date,
      to: chartRange.to_date,
      series: series.rows.map((row) => ({
        date: row.period_start,
        currency: row.currency.trim(),
        amount: row.amount
      })),
      categories: categories.rows.map((row) => ({
        categoryId: row.category_id,
        category: row.category_name ?? "Other",
        currency: row.currency.trim(),
        amount: row.amount
      }))
    };
  });

  app.get("/v1/transactions/export", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const rows = await database.query<{
      transaction_date: string;
      transaction_time: string | null;
      merchant: string;
      amount: string;
      currency: string;
      category_name: string | null;
      card_name: string | null;
    }>(
      `SELECT t.transaction_date::text, t.transaction_time::text,
              t.merchant, t.amount::text, t.currency, c.name AS category_name,
              t.card_name
       FROM transactions t
       LEFT JOIN categories c
         ON c.id = t.category_id
        AND (c.user_id IS NULL OR c.user_id = t.user_id)
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC, t.transaction_time DESC NULLS LAST, t.id DESC`,
      [userId]
    );
    const lines = [
      ["date", "time", "merchant", "amount", "currency", "category", "card"].join(","),
      ...rows.rows.map((row) => [
        csvCell(row.transaction_date, false),
        csvCell(row.transaction_time, false),
        csvCell(row.merchant),
        csvCell(row.amount, false),
        csvCell(row.currency.trim(), false),
        csvCell(row.category_name ?? "Other"),
        csvCell(row.card_name)
      ].join(","))
    ];

    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="moneylens-transactions.csv"')
      .send(`\uFEFF${lines.join("\r\n")}\r\n`);
  });

  app.delete("/v1/transactions", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const result = await database.query(
      "DELETE FROM transactions WHERE user_id = $1",
      [userId]
    );
    return { deletedCount: result.rowCount ?? 0 };
  });

  app.get("/v1/transactions", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return unauthorized(reply);
    }

    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return badRequest(reply, parsedQuery.error.issues[0]?.message ?? "Invalid query parameters");
    }

    const query = parsedQuery.data;
    const conditions = ["t.user_id = $1"];
    const values: unknown[] = [userId];
    const addFilter = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };

    if (query.from) addFilter("t.transaction_date >= ?", query.from);
    if (query.to) addFilter("t.transaction_date <= ?", query.to);
    if (query.categoryId) addFilter("t.category_id = ?", query.categoryId);
    if (query.merchant) addFilter("t.merchant ILIKE ?", `%${query.merchant}%`);
    if (query.cardName) addFilter("t.card_name ILIKE ?", `%${query.cardName}%`);

    const count = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM transactions t
       WHERE ${conditions.join(" AND ")}`,
      values
    );
    values.push(query.limit, query.offset);
    const rows = await database.query<TransactionRow>(
      `SELECT t.id, t.transaction_date::text, t.transaction_time::text,
              t.merchant, t.amount::text, t.currency, t.category_id,
              c.name AS category_name, t.card_name, t.created_at, t.updated_at
       FROM transactions t
       LEFT JOIN categories c
         ON c.id = t.category_id
        AND (c.user_id IS NULL OR c.user_id = t.user_id)
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.transaction_date DESC, t.transaction_time DESC NULLS LAST, t.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    return {
      items: rows.rows.map(transactionResponse),
      total: Number(count.rows[0]?.count ?? "0"),
      limit: query.limit,
      offset: query.offset
    };
  });

  app.get<{ Params: { transactionId: string } }>(
    "/v1/transactions/:transactionId",
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        return unauthorized(reply);
      }

      if (!idSchema.safeParse(request.params.transactionId).success) {
        return badRequest(reply, "Invalid transaction ID");
      }

      const result = await database.query<TransactionRow>(
        `SELECT t.id, t.transaction_date::text, t.transaction_time::text,
                t.merchant, t.amount::text, t.currency, t.category_id,
                c.name AS category_name, t.card_name, t.created_at, t.updated_at
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id
          AND (c.user_id IS NULL OR c.user_id = t.user_id)
         WHERE t.id = $1 AND t.user_id = $2`,
        [request.params.transactionId, userId]
      );

      const transaction = result.rows[0];
      return transaction
        ? transactionResponse(transaction)
        : reply.code(404).send({ error: "Transaction not found" });
    }
  );

  app.patch<{ Params: { transactionId: string } }>(
    "/v1/transactions/:transactionId",
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        return unauthorized(reply);
      }

      if (!idSchema.safeParse(request.params.transactionId).success) {
        return badRequest(reply, "Invalid transaction ID");
      }

      const body = categoryUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return badRequest(reply, "A valid categoryId is required");
      }

      const result = await database.query<TransactionRow>(
        `UPDATE transactions t
         SET category_id = $3, updated_at = now()
         WHERE t.id = $1
           AND t.user_id = $2
           AND (
             $3::uuid IS NULL
             OR EXISTS (
               SELECT 1
               FROM categories c
               WHERE c.id = $3
                 AND (c.user_id IS NULL OR c.user_id = $2)
             )
           )
         RETURNING t.id, t.transaction_date::text, t.transaction_time::text,
                   t.merchant, t.amount::text, t.currency, t.category_id,
                   (SELECT c.name FROM categories c
                    WHERE c.id = t.category_id
                      AND (c.user_id IS NULL OR c.user_id = t.user_id)) AS category_name,
                   t.card_name, t.created_at, t.updated_at`,
        [request.params.transactionId, userId, body.data.categoryId]
      );

      const transaction = result.rows[0];
      return transaction
        ? transactionResponse(transaction)
        : reply.code(404).send({ error: "Transaction or category not found" });
    }
  );
}
