import { describe, expect, it } from "vitest";
import {
  loadPlayerPortalRuntimeConfig,
  PlayerPortalRuntimeConfigError,
} from "../../src/runtime/player-portal-runtime-config.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
const STAGE_DATABASE = "postgresql://pokemon_runtime.rfskcoaoppfrcdmqtvvj@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";

describe("Player Portal runtime config", () => {
  it("loads an exact 32-byte signing key", () => {
    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "development" },
      {
        PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: KEY,
        PLAYER_PORTAL_HOST: "127.0.0.1",
        PORT: "3456",
      },
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3456);
    expect(config.sessionSigningKey).toEqual(Buffer.alloc(32, 9));
  });

  it("keeps Premium off by default and refuses enablement in production", () => {
    const revision = "a".repeat(40);
    const config = (appEnv: "development" | "test" | "staging" | "production", flag?: "0" | "1") =>
      loadPlayerPortalRuntimeConfig(
        { appEnv, databaseUrl: STAGE_DATABASE },
        {
          PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: KEY,
          DEPLOY_REVISION: revision,
          ...(flag ? { PREMIUM_STAGING_ENABLED: flag } : {}),
        },
      );

    expect(config("staging").premiumStagingEnabled).toBe(false);
    expect(config("staging", "0").premiumStagingEnabled).toBe(false);
    expect(config("staging", "1").premiumStagingEnabled).toBe(true);
    for (const environment of ["production", "development", "test"] as const) {
      expect(config(environment, "1").premiumStagingEnabled).toBe(false);
    }
  });

  it("refuses Premium activation when the actual DB origin is absent or foreign", () => {
    const env = {
      PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: KEY,
      DEPLOY_REVISION: "b".repeat(40),
      PREMIUM_STAGING_ENABLED: "1",
    };
    const foreignDb =
      "postgresql://pokemon_runtime.aaaaaaaaaaaaaaaaaaaa@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "staging" }, env))
      .toThrow(PlayerPortalRuntimeConfigError);
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "staging", databaseUrl: foreignDb }, env))
      .toThrow("Premium staging requires the approved dedicated Supabase project");
  });

  it("rejects malformed signing keys", () => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: "not-base64" },
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it("requires deployment revision in staging", () => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "staging" },
        { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: KEY },
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });
});
