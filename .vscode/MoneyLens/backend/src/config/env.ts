import "dotenv/config";
import { Buffer } from "node:buffer";

import { z } from "zod";

const optionalText = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z
      .string()
      .url()
      .refine((value) => /^(postgres|postgresql):\/\//i.test(value), {
        message: "DATABASE_URL must use the postgres or postgresql protocol"
      }),
    DATABASE_SSL: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    APPLE_SIGN_IN_AUDIENCE: optionalText,
    GOOGLE_OAUTH_CLIENT_ID: optionalText,
    GOOGLE_OAUTH_CLIENT_SECRET: optionalText,
    GOOGLE_OAUTH_REDIRECT_URI: optionalText.pipe(z.string().url().optional()),
    GOOGLE_OAUTH_ENCRYPTION_KEY: optionalText
      .refine((value) => {
        if (value === undefined) return true;
        const decoded = Buffer.from(value, "base64");
        return decoded.length === 32 && decoded.toString("base64") === value;
      }, "GOOGLE_OAUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key"),
    GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION: optionalText,
    GMAIL_SEARCH_QUERY: z.string().trim().min(1).default("newer_than:365d {subject:ご利用 subject:利用}"),
    GMAIL_MAX_MESSAGES_PER_SYNC: z.coerce.number().int().min(1).max(2000).default(500)
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && !config.DATABASE_SSL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_SSL must be true in production",
        path: ["DATABASE_SSL"]
      });
    }
    if (config.NODE_ENV === "production" && !config.APPLE_SIGN_IN_AUDIENCE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "APPLE_SIGN_IN_AUDIENCE is required in production",
        path: ["APPLE_SIGN_IN_AUDIENCE"]
      });
    }

    const oauthValues = [
      config.GOOGLE_OAUTH_CLIENT_ID,
      config.GOOGLE_OAUTH_CLIENT_SECRET,
      config.GOOGLE_OAUTH_REDIRECT_URI,
      config.GOOGLE_OAUTH_ENCRYPTION_KEY,
      config.GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION
    ];
    const configuredOAuthValues = oauthValues.filter((value) => value !== undefined).length;
    if (configuredOAuthValues > 0 && configuredOAuthValues < oauthValues.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Google OAuth client, callback, and token-encryption settings must be configured together",
        path: ["GOOGLE_OAUTH_CLIENT_ID"]
      });
    }

    if (
      config.NODE_ENV === "production"
      && configuredOAuthValues !== oauthValues.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Google OAuth and token-encryption settings are required in production",
        path: ["GOOGLE_OAUTH_CLIENT_ID"]
      });
    }

    if (
      config.GOOGLE_OAUTH_REDIRECT_URI
      && config.NODE_ENV !== "development"
      && new URL(config.GOOGLE_OAUTH_REDIRECT_URI).protocol !== "https:"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Google OAuth callback URI must use HTTPS outside development",
        path: ["GOOGLE_OAUTH_REDIRECT_URI"]
      });
    }

    if (
      config.GOOGLE_OAUTH_REDIRECT_URI
      && config.NODE_ENV === "development"
      && new URL(config.GOOGLE_OAUTH_REDIRECT_URI).protocol !== "https:"
      && !["localhost", "127.0.0.1", "::1"].includes(
        new URL(config.GOOGLE_OAUTH_REDIRECT_URI).hostname
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Non-HTTPS Google OAuth callbacks are allowed only on localhost in development",
        path: ["GOOGLE_OAUTH_REDIRECT_URI"]
      });
    }
  });

type EnvironmentConfig = z.infer<typeof environmentSchema>;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: string;
}

export type AppConfig = Omit<
  EnvironmentConfig,
  | "GOOGLE_OAUTH_CLIENT_ID"
  | "GOOGLE_OAUTH_CLIENT_SECRET"
  | "GOOGLE_OAUTH_REDIRECT_URI"
  | "GOOGLE_OAUTH_ENCRYPTION_KEY"
  | "GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION"
> & {
  googleOAuth: GoogleOAuthConfig | null;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
    GOOGLE_OAUTH_ENCRYPTION_KEY: encryptionKey,
    GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION: encryptionKeyVersion,
    ...config
  } = parsed;

  const googleOAuth = clientId && clientSecret && redirectUri && encryptionKey && encryptionKeyVersion
    ? {
        clientId,
        clientSecret,
        redirectUri,
        encryptionKey: Buffer.from(encryptionKey, "base64"),
        encryptionKeyVersion
      }
    : null;

  return { ...config, googleOAuth };
}
