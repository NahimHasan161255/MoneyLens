import "dotenv/config";

import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z
      .string()
      .url()
      .refine((value) => /^(postgres|postgresql):\/\//i.test(value), {
        message: "DATABASE_URL must use the postgres or postgresql protocol"
      }),
    DATABASE_SSL: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && !config.DATABASE_SSL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_SSL must be true in production",
        path: ["DATABASE_SSL"]
      });
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
