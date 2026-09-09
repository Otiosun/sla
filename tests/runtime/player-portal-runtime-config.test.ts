import { describe, expect, it } from "vitest";
import {
  loadPlayerPortalRuntimeConfig,
  PlayerPortalRuntimeConfigError,
} from "../../src/runtime/player-portal-runtime-config.js";

const signingKey = Buffer.alloc(32, 7).toString("base64");
const revision = "a".repeat(40);

describe("player portal runtime config", () => {
  it("loads a canonical signing key with safe network defaults", () => {
    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "development" },
      { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey },
    );

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.sessionSigningKey).toEqual(Buffer.alloc(32, 7));
    expect(config.deploymentRevision).toBeNull();
  });

  it("uses the platform PORT and an explicit host when supplied", () => {
    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "development" },
      {
        PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey,
        PLAYER_PORTAL_HOST: "127.0.0.1",
        PORT: "4177",
      },
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4177);
  });

  it.each([
    "not-base64",
    Buffer.alloc(31, 1).toString("base64"),
    `${Buffer.alloc(32, 1).toString("base64")}=`,
  ])("rejects a non-canonical 32-byte signing key", (invalidKey) => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: invalidKey },
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it("rejects missing signing key and invalid TCP ports", () => {
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "development" }, {})).toThrow(
      PlayerPortalRuntimeConfigError,
    );
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey, PORT: "70000" },
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it("requires and preserves the exact deployment revision in staging", () => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "staging" },
        { PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey },
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);

    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "staging" },
      {
        PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey,
        PORT: "8080",
        DEPLOY_REVISION: revision,
      },
    );

    expect(config.port).toBe(8080);
    expect(config.deploymentRevision).toBe(revision);
  });
});
