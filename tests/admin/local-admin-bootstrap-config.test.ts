import { describe, expect, it } from "vitest";
import {
  LocalAdminBootstrapConfigError,
  loadLocalAdminBootstrapConfig,
} from "../../src/operations/local-admin-bootstrap-config.js";

describe("loadLocalAdminBootstrapConfig", () => {
  it("accepts only an explicit development bootstrap against loopback PostgreSQL", () => {
    const config = loadLocalAdminBootstrapConfig({
      APP_ENV: "development",
      MIGRATOR_DATABASE_URL: "postgresql://postgres:test@127.0.0.1:5432/pokemon_rpg",
    });

    expect(config).toEqual({
      appEnv: "development",
      migratorDatabaseUrl: "postgresql://postgres:test@127.0.0.1:5432/pokemon_rpg",
    });
  });

  it("rejects local bootstrap outside development", () => {
    expect(() =>
      loadLocalAdminBootstrapConfig({
        APP_ENV: "staging",
        MIGRATOR_DATABASE_URL: "postgresql://postgres:test@127.0.0.1:5432/pokemon_rpg",
      }),
    ).toThrow(LocalAdminBootstrapConfigError);
  });

  it("rejects a non-loopback PostgreSQL target even in development", () => {
    expect(() =>
      loadLocalAdminBootstrapConfig({
        APP_ENV: "development",
        MIGRATOR_DATABASE_URL: "postgresql://postgres:test@db.example.com:5432/pokemon_rpg",
      }),
    ).toThrow(/loopback/i);
  });
});
