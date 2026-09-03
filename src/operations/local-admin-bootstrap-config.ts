import { z } from "zod";

const configSchema = z.object({
  APP_ENV: z.literal("development"),
  MIGRATOR_DATABASE_URL: z.string().min(1),
});

export interface LocalAdminBootstrapConfig {
  readonly appEnv: "development";
  readonly migratorDatabaseUrl: string;
}

export class LocalAdminBootstrapConfigError extends Error {
  override readonly name = "LocalAdminBootstrapConfigError";
}

function parseLoopbackPostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalAdminBootstrapConfigError(
      "MIGRATOR_DATABASE_URL must be a valid PostgreSQL URL",
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new LocalAdminBootstrapConfigError("MIGRATOR_DATABASE_URL must use PostgreSQL");
  }
  if (parsed.username.length === 0 || parsed.pathname.length <= 1) {
    throw new LocalAdminBootstrapConfigError(
      "MIGRATOR_DATABASE_URL must include a role and database name",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    throw new LocalAdminBootstrapConfigError(
      "Local admin bootstrap requires a loopback PostgreSQL target",
    );
  }
  return parsed;
}

export function loadLocalAdminBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): LocalAdminBootstrapConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new LocalAdminBootstrapConfigError(
      `Invalid local admin bootstrap configuration: ${issues}`,
    );
  }

  parseLoopbackPostgresUrl(parsed.data.MIGRATOR_DATABASE_URL);
  return {
    appEnv: "development",
    migratorDatabaseUrl: parsed.data.MIGRATOR_DATABASE_URL,
  };
}
