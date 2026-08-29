import { z } from "zod";

const environmentSchema = z.enum(["staging", "production"]);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const identityRefSchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(/^[a-z][a-z0-9._-]{1,31}:\S{1,479}$/);

const configSchema = z.object({
  APP_ENV: environmentSchema,
  DATABASE_URL: z.string().min(1),
  MIGRATOR_DATABASE_URL: z.string().min(1),
  DEPLOY_REVISION: revisionSchema,
  ADMIN_BOOTSTRAP_IDENTITY_REF: identityRefSchema,
  ADMIN_BOOTSTRAP_CONFIRMATION: z.string().min(1),
});

export interface InitialAdminBootstrapConfig {
  readonly appEnv: "staging" | "production";
  readonly runtimeDatabaseUrl: string;
  readonly migratorDatabaseUrl: string;
  readonly deploymentRevision: string;
  readonly identityRef: string;
}

export class InitialAdminBootstrapConfigError extends Error {
  override readonly name = "InitialAdminBootstrapConfigError";
}

function parseDatabaseUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InitialAdminBootstrapConfigError(`${field} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new InitialAdminBootstrapConfigError(`${field} must use PostgreSQL`);
  }
  if (parsed.username.length === 0 || parsed.pathname.length <= 1) {
    throw new InitialAdminBootstrapConfigError(`${field} must include a role and database name`);
  }
  return parsed;
}

function databaseTarget(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

export function expectedInitialAdminBootstrapConfirmation(
  appEnv: "staging" | "production",
  deploymentRevision: string,
): string {
  return `bootstrap-initial-admin:${appEnv}:${deploymentRevision}`;
}

export function loadInitialAdminBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): InitialAdminBootstrapConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new InitialAdminBootstrapConfigError(
      `Invalid initial admin bootstrap configuration: ${issues}`,
    );
  }

  const runtimeUrl = parseDatabaseUrl(parsed.data.DATABASE_URL, "DATABASE_URL");
  const migratorUrl = parseDatabaseUrl(parsed.data.MIGRATOR_DATABASE_URL, "MIGRATOR_DATABASE_URL");
  if (databaseTarget(runtimeUrl) !== databaseTarget(migratorUrl)) {
    throw new InitialAdminBootstrapConfigError(
      "Runtime and migrator credentials must target the same database",
    );
  }
  if (runtimeUrl.username === migratorUrl.username) {
    throw new InitialAdminBootstrapConfigError(
      "Runtime and migrator PostgreSQL roles must be distinct",
    );
  }

  const expectedConfirmation = expectedInitialAdminBootstrapConfirmation(
    parsed.data.APP_ENV,
    parsed.data.DEPLOY_REVISION,
  );
  if (parsed.data.ADMIN_BOOTSTRAP_CONFIRMATION !== expectedConfirmation) {
    throw new InitialAdminBootstrapConfigError(
      "ADMIN_BOOTSTRAP_CONFIRMATION does not match the environment and deploy revision",
    );
  }

  return {
    appEnv: parsed.data.APP_ENV,
    runtimeDatabaseUrl: parsed.data.DATABASE_URL,
    migratorDatabaseUrl: parsed.data.MIGRATOR_DATABASE_URL,
    deploymentRevision: parsed.data.DEPLOY_REVISION,
    identityRef: parsed.data.ADMIN_BOOTSTRAP_IDENTITY_REF,
  };
}
