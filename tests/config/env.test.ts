import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/platform/config/env.js";

describe("loadConfig", () => {
  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ APP_ENV: "test" })).toThrow(ConfigError);
  });

  it("rejects a non-PostgreSQL DATABASE_URL", () => {
    expect(() =>
      loadConfig({ APP_ENV: "test", DATABASE_URL: "https://example.com/database" }),
    ).toThrow(/PostgreSQL URL scheme/);
  });

  it("requires a migrator URL in staging and production", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
      }),
    ).toThrow(/MIGRATOR_DATABASE_URL/);
  });

  it("rejects the same PostgreSQL role for runtime and migrator in production", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://shared:runtime-secret@localhost:5432/pokemon_rpg",
        MIGRATOR_DATABASE_URL: "postgresql://shared:migrator-secret@localhost:5432/pokemon_rpg",
      }),
    ).toThrow(/roles must be distinct/);
  });

  it("accepts distinct runtime and migrator roles in production", () => {
    const config = loadConfig({
      APP_ENV: "production",
      DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
      MIGRATOR_DATABASE_URL: "postgresql://migrator:test@localhost:5432/pokemon_rpg",
    });
    expect(config.migratorDatabaseUrl).toContain("migrator");
  });

  it("loads validated database tuning defaults without exposing unrelated fields", () => {
    const config = loadConfig({
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test",
      UNRELATED_VALUE: "ignored",
    });

    expect(config).toEqual({
      appEnv: "test",
      logLevel: "warn",
      databaseUrl: "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test",
      migratorDatabaseUrl: null,
      databasePoolMax: 10,
      databaseConnectTimeoutMs: 5_000,
      databaseIdleTimeoutMs: 30_000,
      databaseQueryTimeoutMs: 10_000,
      databaseStatementTimeoutMs: 10_000,
      databaseIdleInTransactionTimeoutMs: 15_000,
    });
  });

  it("coerces explicit pool/timeout environment values", () => {
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test",
      DATABASE_POOL_MAX: "4",
      DATABASE_CONNECT_TIMEOUT_MS: "2500",
      DATABASE_IDLE_TIMEOUT_MS: "9000",
      DATABASE_QUERY_TIMEOUT_MS: "0",
      DATABASE_STATEMENT_TIMEOUT_MS: "12000",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "7000",
    });

    expect(config.databasePoolMax).toBe(4);
    expect(config.databaseConnectTimeoutMs).toBe(2_500);
    expect(config.databaseIdleTimeoutMs).toBe(9_000);
    expect(config.databaseQueryTimeoutMs).toBe(0);
    expect(config.databaseStatementTimeoutMs).toBe(12_000);
    expect(config.databaseIdleInTransactionTimeoutMs).toBe(7_000);
  });
});
