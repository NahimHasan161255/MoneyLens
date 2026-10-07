import { TextDecoder } from "node:util";

import { z } from "zod";

import type { ParserInput } from "../parser/types.js";

const gmailApiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

const listResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  nextPageToken: z.string().optional()
});

const historyResponseSchema = z.object({
  history: z.array(z.object({
    messagesAdded: z.array(z.object({
      message: z.object({ id: z.string().min(1) })
    })).optional()
  })).optional(),
  nextPageToken: z.string().optional()
});

const messagePartSchema: z.ZodType<MessagePart> = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(z.object({
    name: z.string(),
    value: z.string()
  })).optional(),
  body: z.object({
    data: z.string().optional()
  }).optional(),
  parts: z.lazy(() => z.array(messagePartSchema)).optional()
});

const messageResponseSchema = z.object({
  id: z.string().min(1),
  payload: messagePartSchema.optional()
});

const profileResponseSchema = z.object({
  historyId: z.string().min(1)
});

const refreshedTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().min(1)
});

interface MessagePart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?: { data?: string | undefined } | undefined;
  parts?: MessagePart[] | undefined;
}

interface GoogleFetchResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface GmailMessage {
  id: string;
  parserInput: ParserInput;
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export class GmailClient {
  private accessToken: string | null = null;
  private accessTokenRequest: Promise<string> | null = null;

  constructor(
    private readonly refreshToken: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async listMessageIds(query: string, maxMessages: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    while (ids.length < maxMessages) {
      const parameters = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(100, maxMessages - ids.length))
      });
      if (pageToken) parameters.set("pageToken", pageToken);

      const payload = await this.apiJson(
        `/messages?${parameters.toString()}`,
        listResponseSchema
      );
      ids.push(...(payload.messages ?? []).map((message) => message.id));
      pageToken = payload.nextPageToken;
      if (!pageToken || payload.messages?.length === 0) break;
    }

    return unique(ids).slice(0, maxMessages);
  }

  async listNewMessageIds(historyId: string, maxMessages: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    while (ids.length < maxMessages) {
      const parameters = new URLSearchParams({
        startHistoryId: historyId,
        historyTypes: "messageAdded",
        maxResults: String(Math.min(500, maxMessages - ids.length))
      });
      if (pageToken) parameters.set("pageToken", pageToken);

      const payload = await this.apiJson(
        `/history?${parameters.toString()}`,
        historyResponseSchema
      );
      for (const entry of payload.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          ids.push(added.message.id);
        }
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }

    return unique(ids).slice(0, maxMessages);
  }

  async message(messageId: string): Promise<GmailMessage | null> {
    const parameters = new URLSearchParams({ format: "full" });
    const response = await this.apiRequest(
      `/messages/${encodeURIComponent(messageId)}?${parameters.toString()}`
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new GmailApiError("Gmail message fetch failed", response.status);

    const raw: unknown = await response.json();
    const parsed = messageResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GmailApiError("Gmail returned an invalid message", 502);
    }

    const payload = parsed.data.payload;
    const headers = payload?.headers ?? [];
    const header = (name: string) => headers.find(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    )?.value ?? "";
    const bodyText = decodeMessageBody(payload);

    return {
      id: parsed.data.id,
      parserInput: {
        sender: header("from"),
        subject: header("subject"),
        bodyText
      }
    };
  }

  async latestHistoryId(): Promise<string> {
    const payload = await this.apiJson("/profile", profileResponseSchema);
    return payload.historyId;
  }

  private async apiJson<Schema extends z.ZodType>(
    path: string,
    schema: Schema
  ): Promise<z.infer<Schema>> {
    const response = await this.apiRequest(path);
    if (!response.ok) {
      throw new GmailApiError("Gmail API request failed", response.status);
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GmailApiError("Gmail API returned an invalid response", 502);
    }
    return parsed.data;
  }

  private async apiRequest(path: string): Promise<Response> {
    const accessToken = await this.getAccessToken();
    return this.fetcher(`${gmailApiBase}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    if (!this.accessTokenRequest) {
      this.accessTokenRequest = this.refreshAccessToken();
    }
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const response = await this.fetcher(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!response.ok) {
      throw new GmailApiError("Google access token refresh failed", response.status);
    }

    const parsed = refreshedTokenSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GmailApiError("Google returned an invalid access token response", 502);
    }
    this.accessToken = parsed.data.access_token;
    return parsed.data.access_token;
  }
}

function decodeMessageBody(part: MessagePart | undefined): string {
  if (!part) return "";

  const textParts: string[] = [];
  const collect = (current: MessagePart) => {
    const data = current.body?.data;
    if (data && (!current.mimeType || current.mimeType.startsWith("text/"))) {
      const bytes = Buffer.from(data, "base64url");
      const contentType = current.headers?.find(
        (header) => header.name.toLowerCase() === "content-type"
      )?.value;
      const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";

      textParts.push(new TextDecoder(charset, { fatal: false }).decode(bytes));
    }
    current.parts?.forEach(collect);
  };

  collect(part);
  return textParts.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
