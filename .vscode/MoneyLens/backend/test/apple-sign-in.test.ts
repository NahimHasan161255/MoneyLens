import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createApp } from "../src/app.js";
import type { QueryExecutor } from "../src/db/database.js";

const audience = "com.example.MoneyLens";
const issuer = "https://appleid.apple.com";
const appleKeysURL = "https://appleid.apple.com/auth/keys";

function queryResult<Row extends import("pg").QueryResultRow>(
  command: string,
  rows: unknown[],
  rowCount = rows.length
) {
  return {
    command,
    rowCount,
    oid: 0,
    fields: [],
    rows: JSON.parse(JSON.stringify(rows)) as Row[]
  };
}

test("Apple sign-in validates the Apple token and consumes a challenge once", async (context) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJWK = await exportJWK(publicKey);
  publicJWK.kid = "moneylens-test-key";
  publicJWK.use = "sig";
  publicJWK.alg = "RS256";

  const rawNonce: string[] = [];
  let consumedNonceHash: Buffer | null = null;
  let usersCreated = 0;
  let sessionsCreated = 0;
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      if (text.includes("DELETE FROM apple_sign_in_nonces")) {
        return queryResult<Row>("DELETE", []);
      }
      if (text.includes("INSERT INTO apple_sign_in_nonces")) {
        rawNonce.push(Buffer.from(values[0] as Buffer).toString("hex"));
        return queryResult<Row>("INSERT", [], 1);
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  };
  const transactionExecutor = {
    ...queryExecutor,
    async transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T> {
      return operation({
        async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
          text: string,
          values: readonly unknown[] = []
        ) {
          if (text.includes("UPDATE apple_sign_in_nonces")) {
            const presentedHash = values[0] as Buffer;
            const nonceIsValid = rawNonce.includes(presentedHash.toString("hex"))
              && !consumedNonceHash?.equals(presentedHash);
            if (nonceIsValid) {
              consumedNonceHash = presentedHash;
            }
            return queryResult<Row>("UPDATE", nonceIsValid ? [{ nonce_hash: presentedHash }] : []);
          }
          if (text.includes("INSERT INTO users")) {
            usersCreated += 1;
            return queryResult<Row>("INSERT", [{ id: "37ead7aa-8b11-4b64-bbdd-f36e6ca7a323" }]);
          }
          if (text.includes("INSERT INTO app_sessions")) {
            sessionsCreated += 1;
            return queryResult<Row>("INSERT", [], 1);
          }
          throw new Error(`Unexpected transactional query: ${text}`);
        }
      });
    }
  };
  const fetcher: typeof fetch = async (input) => {
    assert.equal(String(input), appleKeysURL);
    return new Response(JSON.stringify({ keys: [publicJWK] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    transactionExecutor,
    environment: "test",
    appleSignInAudience: audience,
    googleFetch: fetcher
  });
  context.after(() => app.close());

  const nonceResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/apple/nonce",
    payload: {}
  });
  assert.equal(nonceResponse.statusCode, 201);
  const nonce = nonceResponse.json<{ nonce: string }>().nonce;
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);

  const hashedNonce = createHash("sha256").update(nonce).digest("hex");
  const identityToken = await new SignJWT({ nonce: hashedNonce })
    .setProtectedHeader({ alg: "RS256", kid: publicJWK.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("apple-user-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const wrongAudienceToken = await new SignJWT({ nonce: hashedNonce })
    .setProtectedHeader({ alg: "RS256", kid: publicJWK.kid })
    .setIssuer(issuer)
    .setAudience("com.example.WrongApp")
    .setSubject("apple-user-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const wrongAudienceResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/apple",
    payload: { identityToken: wrongAudienceToken, nonce }
  });
  assert.equal(wrongAudienceResponse.statusCode, 401);

  const wrongNonceToken = await new SignJWT({ nonce: "wrong-nonce" })
    .setProtectedHeader({ alg: "RS256", kid: publicJWK.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("apple-user-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const wrongNonceResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/apple",
    payload: { identityToken: wrongNonceToken, nonce }
  });
  assert.equal(wrongNonceResponse.statusCode, 401);

  const signInResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/apple",
    payload: { identityToken, nonce }
  });
  assert.equal(signInResponse.statusCode, 200);
  assert.equal(signInResponse.json<{ tokenType: string }>().tokenType, "Bearer");
  assert.equal(signInResponse.json<{ expiresIn: number }>().expiresIn, 604800);
  assert.equal(usersCreated, 1);
  assert.equal(sessionsCreated, 1);

  const replayResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/apple",
    payload: { identityToken, nonce }
  });
  assert.equal(replayResponse.statusCode, 401);
  assert.equal(usersCreated, 1);
  assert.equal(sessionsCreated, 1);
});

test("Apple sign-in endpoints require a configured app audience", async (context) => {
  const queryExecutor: QueryExecutor = {
    async query<Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>() {
      return queryResult<Row>("SELECT", []);
    }
  };
  const transactionExecutor = {
    ...queryExecutor,
    async transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T> {
      return operation(queryExecutor);
    }
  };
  const app = createApp({ async ping() {}, async close() {} }, {
    logger: false,
    queryExecutor,
    transactionExecutor,
    environment: "test"
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/apple/nonce",
    payload: {}
  });

  assert.equal(response.statusCode, 503);
});
