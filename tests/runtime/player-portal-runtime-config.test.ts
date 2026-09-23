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
});
