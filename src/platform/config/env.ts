import { z } from "zod";

const postgresUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    "must use the PostgreSQL URL scheme",
  );
const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);
const nonNegativeInteger = (defaultValue: number) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: postgresUrl,
  MIGRATOR_DATABASE_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: positiveInteger(10),
  DATABASE_CONNECT_TIMEOUT_MS: positiveInteger(5_000),
  DATABASE_IDLE_TIMEOUT_MS: positiveInteger(30_000),
  DATABASE_QUERY_TIMEOUT_MS: nonNegativeInteger(10_000),
  DATABASE_STATEMENT_TIMEOUT_MS: nonNegativeInteger(10_000),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: positiveInteger(15_000),
});

export interface AppConfig {
  readonly appEnv: "development" | "test" | "staging" | "production";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly databaseUrl: string;
  readonly migratorDatabaseUrl: string | null;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseQueryTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly databaseIdleInTransactionTimeoutMs: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function databaseUsername(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).username);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid application configuration: ${issues}`);
  }

  const requiresRoleSeparation =
    parsed.data.APP_ENV === "staging" || parsed.data.APP_ENV === "production";
  if (requiresRoleSeparation && parsed.data.MIGRATOR_DATABASE_URL === undefined) {
    throw new ConfigError(
      "Invalid application configuration: MIGRATOR_DATABASE_URL is required in staging/production",
    );
  }
  if (
    requiresRoleSeparation &&
    parsed.data.MIGRATOR_DATABASE_URL !== undefined &&
    databaseUsername(parsed.data.DATABASE_URL) === databaseUsername(parsed.data.MIGRATOR_DATABASE_URL)
  ) {
    throw new ConfigError(
      "Invalid application configuration: runtime and migrator PostgreSQL roles must be distinct in staging/production",
    );
  }

  return {
    appEnv: parsed.data.APP_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    migratorDatabaseUrl: parsed.data.MIGRATOR_DATABASE_URL ?? null,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: parsed.data.DATABASE_CONNECT_TIMEOUT_MS,
    databaseIdleTimeoutMs: parsed.data.DATABASE_IDLE_TIMEOUT_MS,
    databaseQueryTimeoutMs: parsed.data.DATABASE_QUERY_TIMEOUT_MS,
    databaseStatementTimeoutMs: parsed.data.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseIdleInTransactionTimeoutMs: parsed.data.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}
