import { describe, expect, it } from "vitest";
import {
  loadPlayerPortalRuntimeConfig,
  PlayerPortalRuntimeConfigError,
} from "../../src/runtime/player-portal-runtime-config.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

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

  it("rejects Premium staging against absent or foreign database", () => {
    const base = {
      PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: KEY,
      DEPLOY_REVISION: "d".repeat(40),
      PREMIUM_MANUAL_DELIVERY_ENABLED: "1",
    };
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "staging" }, base))
      .toThrow("Premium staging requires the approved isolated database");
    expect(() => loadPlayerPortalRuntimeConfig({
      appEnv: "staging",
      databaseUrl: "postgresql://dummy:dummy@localhost:5432/prod",
    }, base)).toThrow("Premium staging requires the approved isolated database");
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "production" }, base))
      .toThrow("Premium manual delivery can only be enabled in staging");
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "development" }, {
      ...base,
      PREMIUM_MANUAL_DELIVERY_ENABLED: "0",
    })).not.toThrow();
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "production" }, {
      ...base,
      PREMIUM_MANUAL_DELIVERY_ENABLED: "0",
      PREMIUM_MASTER_DELIVERY_ENABLED: "1",
    })).toThrow("Premium manual delivery can only be enabled in staging");
  });});
