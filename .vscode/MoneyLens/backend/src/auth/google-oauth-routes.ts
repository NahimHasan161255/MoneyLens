import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { GoogleOAuthConfig } from "../config/env.js";
import type { QueryExecutor } from "../db/database.js";
import { OAuthTokenCipher } from "../security/oauth-token-cipher.js";

const gmailReadOnlyScope = "https://www.googleapis.com/auth/gmail.readonly";
const oauthStateLifetimeMinutes = 10;
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleProfileEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const googleRevokeEndpoint = "https://oauth2.googleapis.com/revoke";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  token_type: z.string().min(1)
});

const profileResponseSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.string().min(1)
});

interface OAuthFlowRow {
  id: string;
  user_id: string;
}

interface ExistingConnectionRow {
  user_id: string;
  encrypted_refresh_token: Buffer;
  encryption_key_version: string;
}

interface ConnectionRow {
  connected_at: Date;
}

interface ConnectedAccountRow {
  id: string;
  encrypted_refresh_token: Buffer;
  encryption_key_version: string;
}

type GoogleFetch = typeof fetch;

function stateHash(state: string): Buffer {
  return createHash("sha256").update(state).digest();
}

function callbackPage(
  reply: FastifyReply,
  statusCode: number,
  title: string,
  message: string
): unknown {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><p>${message}</p><p>You can return to MoneyLens.</p></main></html>`);
}

async function tokenRequest(
  fetcher: GoogleFetch,
  body: URLSearchParams
): Promise<z.infer<typeof tokenResponseSchema>> {
  const response = await fetcher(googleTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`Google token endpoint returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Google token endpoint returned an invalid response");
  }
  return parsed.data;
}

export function registerGoogleOAuthRoutes(
  app: FastifyInstance,
  database: QueryExecutor,
  config: GoogleOAuthConfig | null,
  fetcher: GoogleFetch = fetch
): void {
  const cipher = config
    ? new OAuthTokenCipher(config.encryptionKey, config.encryptionKeyVersion)
    : null;

  app.post("/v1/gmail/connect", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!config) {
      return reply.code(503).send({
        error: "Google OAuth is not configured on this server."
      });
    }

    const state = randomBytes(32).toString("base64url");
    await database.query(
      `INSERT INTO google_oauth_flows (user_id, state_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 minute'))`,
      [userId, stateHash(state), oauthStateLifetimeMinutes]
    );

    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: gmailReadOnlyScope,
      access_type: "offline",
      prompt: "consent",
      state
    }).toString();

    return reply.code(201).send({
      authorizationUrl: authorizationUrl.toString(),
      expiresIn: oauthStateLifetimeMinutes * 60
    });
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/oauth/google/callback",
    async (request, reply) => {
      if (!config || !cipher) {
        return callbackPage(
          reply,
          503,
          "MoneyLens is not configured",
          "Google account connection is unavailable."
        );
      }

      const state = request.query.state;
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
        return callbackPage(reply, 400, "Connection expired", "Please restart account connection in MoneyLens.");
      }

      const flow = await database.query<OAuthFlowRow>(
        `UPDATE google_oauth_flows
         SET status = 'processing'
         WHERE state_hash = $1
           AND status = 'pending'
           AND expires_at > now()
         RETURNING id, user_id`,
        [stateHash(state)]
      );
      const flowRow = flow.rows[0];
      if (!flowRow) {
        return callbackPage(reply, 400, "Connection expired", "Please restart account connection in MoneyLens.");
      }

      if (request.query.error) {
        await database.query(
          `UPDATE google_oauth_flows
           SET status = 'failed', error_code = 'authorization_denied', completed_at = now()
           WHERE id = $1`,
          [flowRow.id]
        );
        return callbackPage(reply, 400, "Connection cancelled", "No Gmail account was connected.");
      }

      if (!request.query.code || request.query.code.length > 2048) {
        await failFlow(database, flowRow.id, "missing_authorization_code");
        return callbackPage(reply, 400, "Connection failed", "Please restart account connection in MoneyLens.");
      }

      try {
        const tokens = await tokenRequest(fetcher, new URLSearchParams({
          code: request.query.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code"
        }));
        const profileResponse = await fetcher(googleProfileEndpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}` }
        });
        if (!profileResponse.ok) {
          throw new Error(`Gmail profile endpoint returned HTTP ${profileResponse.status}`);
        }

        const profilePayload: unknown = await profileResponse.json();
        const profile = profileResponseSchema.safeParse(profilePayload);
        if (!profile.success) {
          throw new Error("Gmail profile endpoint returned an invalid response");
        }

        const existingAccount = await database.query<ExistingConnectionRow>(
          `SELECT user_id, encrypted_refresh_token, encryption_key_version
           FROM oauth_connections
           WHERE provider = 'google' AND provider_subject = $1`,
          [profile.data.emailAddress]
        );
        const existing = existingAccount.rows[0];
        if (existing && existing.user_id !== flowRow.user_id) {
          await failFlow(database, flowRow.id, "account_already_linked");
          return callbackPage(
            reply,
            409,
            "Account already connected",
            "This Google account is already connected to another MoneyLens account."
          );
        }

        const storedToken = tokens.refresh_token
          ? cipher.encrypt(tokens.refresh_token)
          : existing && existing.user_id === flowRow.user_id
            ? {
                ciphertext: existing.encrypted_refresh_token,
                keyVersion: existing.encryption_key_version
              }
            : null;

        if (!storedToken) {
          throw new Error("Google did not issue a refresh token");
        }

        await database.query(
          `INSERT INTO oauth_connections (
             user_id, provider, provider_subject, encrypted_refresh_token,
             encryption_key_version, granted_scopes
           )
           VALUES ($1, 'google', $2, $3, $4, $5)
           ON CONFLICT (user_id, provider)
           DO UPDATE SET
             provider_subject = EXCLUDED.provider_subject,
             encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
             encryption_key_version = EXCLUDED.encryption_key_version,
             granted_scopes = EXCLUDED.granted_scopes,
             updated_at = now()`,
          [
            flowRow.user_id,
            profile.data.emailAddress,
            storedToken.ciphertext,
            storedToken.keyVersion,
            [gmailReadOnlyScope]
          ]
        );
        await database.query(
          `INSERT INTO gmail_sync_state (user_id, history_id, last_synced_at)
           VALUES ($1, $2, NULL)
           ON CONFLICT (user_id)
           DO UPDATE SET history_id = EXCLUDED.history_id, updated_at = now()`,
          [flowRow.user_id, profile.data.historyId]
        );
        await database.query(
          `UPDATE google_oauth_flows
           SET status = 'connected', completed_at = now()
           WHERE id = $1`,
          [flowRow.id]
        );

        return callbackPage(reply, 200, "Gmail connected", "Your Gmail account is connected to MoneyLens.");
      } catch (error) {
        request.log.error(
          { err: error, flowId: flowRow.id },
          "Google OAuth callback failed"
        );
        await failFlow(database, flowRow.id, "oauth_exchange_failed");
        return callbackPage(
          reply,
          502,
          "Connection failed",
          "MoneyLens could not complete the Google connection. Please try again."
        );
      }
    }
  );

  app.get("/v1/gmail/connection", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const result = await database.query<ConnectionRow>(
      `SELECT created_at AS connected_at
       FROM oauth_connections
       WHERE user_id = $1 AND provider = 'google'`,
      [userId]
    );
    return {
      connected: result.rows.length > 0,
      connectedAt: result.rows[0]?.connected_at ?? null
    };
  });

  app.delete("/v1/gmail/connection", async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const connection = await database.query<ConnectedAccountRow>(
      `DELETE FROM oauth_connections
       WHERE user_id = $1 AND provider = 'google'
       RETURNING id, encrypted_refresh_token, encryption_key_version`,
      [userId]
    );
    await database.query("DELETE FROM gmail_sync_state WHERE user_id = $1", [userId]);

    const stored = connection.rows[0];
    if (!stored || !config || !cipher) {
      return { disconnected: true, googleRevocation: stored ? "unavailable" : "not_connected" };
    }

    try {
      const refreshToken = cipher.decrypt({
        ciphertext: stored.encrypted_refresh_token,
        keyVersion: stored.encryption_key_version
      });
      const response = await fetcher(googleRevokeEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken })
      });

      if (!response.ok) {
        request.log.error(
          { statusCode: response.status },
          "Google token revocation failed after local disconnect"
        );
        return reply.code(502).send({
          disconnected: true,
          googleRevocation: "failed"
        });
      }
    } catch (error) {
      request.log.error({ err: error }, "Google token revocation failed after local disconnect");
      return reply.code(502).send({
        disconnected: true,
        googleRevocation: "failed"
      });
    }

    return { disconnected: true, googleRevocation: "revoked" };
  });
}

async function failFlow(
  database: QueryExecutor,
  flowId: string,
  errorCode: string
): Promise<void> {
  await database.query(
    `UPDATE google_oauth_flows
     SET status = 'failed', error_code = $2, completed_at = now()
     WHERE id = $1`,
    [flowId, errorCode]
  );
}
