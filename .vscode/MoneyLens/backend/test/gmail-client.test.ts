import assert from "node:assert/strict";
import { test } from "node:test";

import { GmailApiError, GmailClient } from "../src/gmail/gmail-client.js";

const japaneseBody = "ご利用日：2026年10月5日\nご利用先：テスト店舗\nご利用金額：3500円";

function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>
): typeof fetch {
  return async (input, init) => handler(new URL(String(input)), init);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

test("refreshes Gmail access server-side and only requests required API data", async () => {
  const requests: Array<{ url: URL; headers: Headers; body: string }> = [];
  const fetcher = mockFetch((url, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
        ? init.body.toString()
        : "";
    requests.push({ url, headers, body });

    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({
        access_token: "temporary-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname.endsWith("/messages")) {
      return jsonResponse({ messages: [{ id: "msg-1" }] });
    }
    if (url.pathname.endsWith("/messages/msg-1")) {
      return jsonResponse({
        id: "msg-1",
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from(japaneseBody).toString("base64url") }
            },
            {
              mimeType: "image/png",
              body: { data: Buffer.from("private-attachment").toString("base64url") }
            }
          ],
          headers: [
            { name: "From", value: "Card Notice <notice@example.jp>" },
            { name: "Subject", value: "カードご利用のお知らせ" }
          ]
        }
      });
    }
    if (url.pathname.endsWith("/profile")) {
      return jsonResponse({ historyId: "900" });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  const gmail = new GmailClient(
    "refresh-token",
    "client-id",
    "client-secret",
    fetcher
  );

  const ids = await gmail.listMessageIds("subject:ご利用", 50);
  const message = await gmail.message(ids[0]!);
  const historyId = await gmail.latestHistoryId();

  assert.deepEqual(ids, ["msg-1"]);
  assert.equal(historyId, "900");
  assert.deepEqual(message, {
    id: "msg-1",
    parserInput: {
      sender: "Card Notice <notice@example.jp>",
      subject: "カードご利用のお知らせ",
      bodyText: japaneseBody
    }
  });
  assert.equal(requests[0]?.headers.has("authorization"), false);
  assert.match(requests[0]?.body ?? "", /refresh_token=refresh-token/);
  assert.equal(
    requests.filter((request) => request.headers.get("authorization") === "Bearer temporary-access-token").length,
    3
  );
  const messageRequest = requests.find((request) => request.url.pathname.endsWith("/messages/msg-1"));
  assert.equal(messageRequest?.url.searchParams.get("format"), "full");
});

test("history sync reads only newly added message identifiers", async () => {
  const fetcher = mockFetch((url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({
        access_token: "temporary-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname.endsWith("/history")) {
      assert.equal(url.searchParams.get("startHistoryId"), "500");
      assert.equal(url.searchParams.get("historyTypes"), "messageAdded");
      return jsonResponse({
        history: [
          {
            messagesAdded: [
              { message: { id: "new-1" } },
              { message: { id: "new-2" } }
            ]
          }
        ]
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  const gmail = new GmailClient("refresh", "client", "secret", fetcher);

  assert.deepEqual(await gmail.listNewMessageIds("500", 25), ["new-1", "new-2"]);
});

test("concurrent Gmail requests share one access-token refresh", async () => {
  let refreshCount = 0;
  const fetcher = mockFetch((url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      refreshCount += 1;
      return jsonResponse({
        access_token: "temporary-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname.endsWith("/profile")) {
      return jsonResponse({ historyId: "900" });
    }
    if (url.pathname.endsWith("/messages")) {
      return jsonResponse({ messages: [{ id: "msg-1" }] });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  const gmail = new GmailClient("refresh", "client", "secret", fetcher);

  const [historyId, messageIds] = await Promise.all([
    gmail.latestHistoryId(),
    gmail.listMessageIds("subject:card", 20)
  ]);

  assert.equal(historyId, "900");
  assert.deepEqual(messageIds, ["msg-1"]);
  assert.equal(refreshCount, 1);
});

test("reports Gmail HTTP errors as typed failures without response body text", async () => {
  const fetcher = mockFetch((url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({
        access_token: "temporary-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    return new Response("private mail content", { status: 401 });
  });
  const gmail = new GmailClient("refresh", "client", "secret", fetcher);

  await assert.rejects(
    gmail.latestHistoryId(),
    (error: unknown) => {
      assert.ok(error instanceof GmailApiError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.message.includes("private mail content"), false);
      return true;
    }
  );
});
