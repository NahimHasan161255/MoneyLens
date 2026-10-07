import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { customFetch, createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";

import type {
  QueryExecutor,
  TransactionalQueryExecutor
} from "../db/database.js";

const appleIssuer = "https://appleid.apple.com";
const appleJwksURL = new URL("https://appleid.apple.com/auth/keys");
const nonceLifetimeMinutes = 5;
const sessionLifetimeDays = 7;
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signInSchema = z.object({
  identityToken: z.string().min(1).max(16_384),
  nonce: nonceSchema
});

type Fetcher = typeof fetch;

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function appleNonceClaim(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function registerAppleSignInRoutes(
  app: FastifyInstance,
  database: QueryExecutor,
  transactions: TransactionalQueryExecutor,
  audience: string | undefined,
  fetcher: Fetcher = fetch
): void {
  const jwks = createRemoteJWKSet(appleJwksURL, {
    [customFetch]: fetcher as typeof globalThis.fetch
  });

  app.post("/v1/auth/apple/nonce", async (_request, reply) => {
    if (!audience) {
      return reply.code(503).send({ error: "Apple sign-in is not configured." });
    }

    const nonce = randomBytes(32).toString("base64url");
    await database.query(
      `DELETE FROM apple_sign_in_nonces
       WHERE expires_at <= now()`
    );
    await database.query(
      `INSERT INTO apple_sign_in_nonces (nonce_hash, expires_at)
       VALUES ($1, now() + ($2 * interval '1 minute'))`,
      [hash(nonce), nonceLifetimeMinutes]
    );
    return reply.code(201).send({ nonce, expiresIn: nonceLifetimeMinutes * 60 });
  });

  app.post("/v1/auth/apple", async (request, reply) => {
    if (!audience) {
      return reply.code(503).send({ error: "Apple sign-in is not configured." });
    }

    const input = signInSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "A valid Apple identity token and nonce are required." });
    }

    let subject: string;
    try {
      const verified = await jwtVerify(input.data.identityToken, jwks, {
        issuer: appleIssuer,
        audience,
        algorithms: ["RS256"],
        maxTokenAge: "10m",
        requiredClaims: ["exp", "iat", "sub", "nonce"]
      });
      if (
        typeof verified.payload.sub !== "string"
        || verified.payload.sub.length === 0
        || verified.payload.nonce !== appleNonceClaim(input.data.nonce)
      ) {
        return reply.code(401).send({ error: "Apple identity token is invalid or expired." });
      }
      subject = verified.payload.sub;
    } catch (error) {
      if (error instanceof errors.JOSEError) {
        return reply.code(401).send({ error: "Apple identity token is invalid or expired." });
      }
      request.log.error({ err: error }, "Apple identity verification service failed");
      return reply.code(503).send({ error: "Apple sign-in is temporarily unavailable." });
    }

    const accessToken = randomBytes(32).toString("base64url");
    const tokenHash = hash(accessToken);
    try {
      await transactions.transaction(async (executor) => {
        const challenge = await executor.query(
          `UPDATE apple_sign_in_nonces
           SET consumed_at = now()
           WHERE nonce_hash = $1
             AND consumed_at IS NULL
             AND expires_at > now()
           RETURNING nonce_hash`,
          [hash(input.data.nonce)]
        );
        if (challenge.rowCount !== 1) {
          throw new InvalidAppleNonceError();
        }

        const user = await executor.query<{ id: string }>(
          `INSERT INTO users (auth_subject)
           VALUES ($1)
           ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [`apple:${subject}`]
        );
        const userId = user.rows[0]?.id;
        if (!userId) {
          throw new Error("Apple sign-in could not create the user session.");
        }
        await executor.query(
          `INSERT INTO app_sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
          [userId, tokenHash, sessionLifetimeDays]
        );
      });
    } catch (error) {
      if (error instanceof InvalidAppleNonceError) {
        return reply.code(401).send({ error: "Apple sign-in challenge expired or was already used." });
      }
      throw error;
    }

    return reply.code(200).send({
      accessToken,
      tokenType: "Bearer",
      expiresIn: sessionLifetimeDays * 24 * 60 * 60
    });
  });
}

class InvalidAppleNonceError extends Error {}
