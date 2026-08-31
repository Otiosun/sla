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
const environmentBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

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
  ADMIN_API_ENABLED: environmentBoolean,
  ADMIN_API_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  ADMIN_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  ADMIN_API_ALLOWED_ORIGIN: z.string().url().optional(),
  ADMIN_ACCESS_TEAM_DOMAIN: z.string().url().optional(),
  ADMIN_ACCESS_AUDIENCE: z.string().trim().min(1).max(256).optional(),
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
  readonly adminApiEnabled: boolean;
  readonly adminApiHost: string;
  readonly adminApiPort: number;
  readonly adminApiAllowedOrigin: string | null;
  readonly adminAccessTeamDomain: string | null;
  readonly adminAccessAudience: string | null;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function databaseUsername(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).username);
}

function normalizeOrigin(rawOrigin: string, appEnv: AppConfig["appEnv"]): string {
  const url = new URL(rawOrigin);
  if (url.origin !== rawOrigin || url.username || url.password) {
    throw new ConfigError(
      "Invalid application configuration: ADMIN_API_ALLOWED_ORIGIN must be an exact origin",
    );
  }
  if ((appEnv === "staging" || appEnv === "production") && url.protocol !== "https:") {
    throw new ConfigError(
      "Invalid application configuration: ADMIN_API_ALLOWED_ORIGIN must use HTTPS in staging/production",
    );
  }
  return url.origin;
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
  if (
    requiresRoleSeparation &&
    parsed.data.MIGRATOR_DATABASE_URL !== undefined &&
    databaseUsername(parsed.data.DATABASE_URL) ===
      databaseUsername(parsed.data.MIGRATOR_DATABASE_URL)
  ) {
    throw new ConfigError(
      "Invalid application configuration: runtime and migrator PostgreSQL roles must be distinct in staging/production",
    );
  }

  if (
    parsed.data.ADMIN_API_ENABLED &&
    (parsed.data.ADMIN_API_ALLOWED_ORIGIN === undefined ||
      parsed.data.ADMIN_ACCESS_TEAM_DOMAIN === undefined ||
      parsed.data.ADMIN_ACCESS_AUDIENCE === undefined)
  ) {
    throw new ConfigError(
      "Invalid application configuration: enabled Admin API requires allowed origin, Access team domain, and Access audience",
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
    adminApiEnabled: parsed.data.ADMIN_API_ENABLED,
    adminApiHost: parsed.data.ADMIN_API_HOST,
    adminApiPort: parsed.data.ADMIN_API_PORT,
    adminApiAllowedOrigin:
      parsed.data.ADMIN_API_ALLOWED_ORIGIN === undefined
        ? null
        : normalizeOrigin(parsed.data.ADMIN_API_ALLOWED_ORIGIN, parsed.data.APP_ENV),
    adminAccessTeamDomain: parsed.data.ADMIN_ACCESS_TEAM_DOMAIN ?? null,
    adminAccessAudience: parsed.data.ADMIN_ACCESS_AUDIENCE ?? null,
  };
}
