import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/platform/config/env.js";

describe("loadConfig", () => {
  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ APP_ENV: "test" })).toThrow(ConfigError);
  });

  it("rejects a non-PostgreSQL DATABASE_URL", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: "https://example.com/database",
      }),
    ).toThrow(/PostgreSQL URL scheme/);
  });

  it("loads validated configuration without exposing extra environment fields", () => {
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
    });
  });
});
