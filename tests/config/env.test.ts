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

  it("accepts runtime-only database config in staging and production", () => {
    for (const appEnv of ["staging", "production"] as const) {
      const config = loadConfig({
        APP_ENV: appEnv,
        DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
      });
      expect(config.migratorDatabaseUrl).toBeNull();
    }
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

  it("keeps the Admin API disabled by default", () => {
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test",
    });

    expect(config.adminApiEnabled).toBe(false);
    expect(config.adminApiAllowedOrigin).toBeNull();
    expect(config.adminAccessTeamDomain).toBeNull();
    expect(config.adminAccessAudience).toBeNull();
  });

  it("fails fast when Admin API is enabled without its Access boundary", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test",
        ADMIN_API_ENABLED: "true",
      }),
    ).toThrow(/enabled Admin API requires allowed origin/);
  });

  it("requires an HTTPS exact admin origin in production without requiring a migrator secret", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
        ADMIN_API_ENABLED: "true",
        ADMIN_API_ALLOWED_ORIGIN: "http://admin.example.com",
        ADMIN_ACCESS_TEAM_DOMAIN: "https://pokemon-rpg.cloudflareaccess.com",
        ADMIN_ACCESS_AUDIENCE: "control-center-audience",
      }),
    ).toThrow(/must use HTTPS/);
  });

  it("loads a complete enabled Admin API boundary with runtime-only database credentials", () => {
    const config = loadConfig({
      APP_ENV: "staging",
      DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
      ADMIN_API_ENABLED: "true",
      ADMIN_API_HOST: "0.0.0.0",
      ADMIN_API_PORT: "8787",
      ADMIN_API_ALLOWED_ORIGIN: "https://admin-staging.example.com",
      ADMIN_ACCESS_TEAM_DOMAIN: "https://pokemon-rpg.cloudflareaccess.com",
      ADMIN_ACCESS_AUDIENCE: "control-center-audience",
      ADMIN_ACCESS_SESSION_IDLE_TIMEOUT_MS: "1200000",
    });

    expect(config).toMatchObject({
      migratorDatabaseUrl: null,
      adminApiEnabled: true,
      adminApiHost: "0.0.0.0",
      adminApiPort: 8_787,
      adminApiAllowedOrigin: "https://admin-staging.example.com",
      adminAccessTeamDomain: "https://pokemon-rpg.cloudflareaccess.com",
      adminAccessAudience: "control-center-audience",
      adminAccessSessionIdleTimeoutMs: 1_200_000,
    });
  });

  it("loads validated database and Admin API defaults without exposing unrelated fields", () => {
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
      adminApiEnabled: false,
      adminApiHost: "127.0.0.1",
      adminApiPort: 8_787,
      adminApiAllowedOrigin: null,
      adminAccessTeamDomain: null,
      adminAccessAudience: null,
      adminAccessSessionIdleTimeoutMs: 900_000,
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
