import { describe, expect, it } from "vitest";
import {
  loadPlayerPortalRuntimeConfig,
  PlayerPortalRuntimeConfigError,
} from "../../src/runtime/player-portal-runtime-config.js";

const signingKey = Buffer.alloc(32, 7).toString("base64");
const encounterRngKey = Buffer.alloc(32, 9).toString("base64");
const revision = "a".repeat(40);
const railwayRevision = "b".repeat(40);

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: signingKey,
    ENCOUNTER_RNG_KEY_BASE64: encounterRngKey,
    ENCOUNTER_RNG_KEY_VERSION: "1",
    ...overrides,
  };
}

describe("player portal runtime config", () => {
  it("loads independent canonical session and encounter keys with safe network defaults", () => {
    const config = loadPlayerPortalRuntimeConfig({ appEnv: "development" }, validEnv());

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.sessionSigningKey).toEqual(Buffer.alloc(32, 7));
    expect(config.encounterRngKey).toEqual(Buffer.alloc(32, 9));
    expect(config.encounterRngKeyVersion).toBe(1);
    expect(config.deploymentRevision).toBeNull();
  });

  it("uses the platform PORT and an explicit host when supplied", () => {
    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "development" },
      validEnv({
        PLAYER_PORTAL_HOST: "127.0.0.1",
        PORT: "4177",
      }),
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
        validEnv({ PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: invalidKey }),
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it.each([
    "not-base64",
    Buffer.alloc(31, 1).toString("base64"),
    `${Buffer.alloc(32, 1).toString("base64")}=`,
  ])("rejects a non-canonical 32-byte encounter RNG key", (invalidKey) => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        validEnv({ ENCOUNTER_RNG_KEY_BASE64: invalidKey }),
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid encounter RNG key version %s",
    (invalidVersion) => {
      expect(() =>
        loadPlayerPortalRuntimeConfig(
          { appEnv: "development" },
          validEnv({ ENCOUNTER_RNG_KEY_VERSION: invalidVersion }),
        ),
      ).toThrow(PlayerPortalRuntimeConfigError);
    },
  );

  it("rejects missing required keys and invalid TCP ports", () => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        validEnv({ PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: undefined }),
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "development" },
        validEnv({ ENCOUNTER_RNG_KEY_BASE64: undefined }),
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
    expect(() =>
      loadPlayerPortalRuntimeConfig({ appEnv: "development" }, validEnv({ PORT: "70000" })),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });

  it("requires and preserves the exact deployment revision in staging", () => {
    expect(() => loadPlayerPortalRuntimeConfig({ appEnv: "staging" }, validEnv())).toThrow(
      PlayerPortalRuntimeConfigError,
    );

    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "staging" },
      validEnv({
        PORT: "8080",
        DEPLOY_REVISION: revision,
      }),
    );

    expect(config.port).toBe(8080);
    expect(config.deploymentRevision).toBe(revision);
  });

  it("uses the Railway-injected Git commit SHA as deployment provenance", () => {
    const config = loadPlayerPortalRuntimeConfig(
      { appEnv: "staging" },
      validEnv({
        RAILWAY_GIT_COMMIT_SHA: railwayRevision,
      }),
    );

    expect(config.deploymentRevision).toBe(railwayRevision);
  });

  it("rejects a manual deployment revision that disagrees with Railway provenance", () => {
    expect(() =>
      loadPlayerPortalRuntimeConfig(
        { appEnv: "staging" },
        validEnv({
          RAILWAY_GIT_COMMIT_SHA: railwayRevision,
          DEPLOY_REVISION: revision,
        }),
      ),
    ).toThrow(PlayerPortalRuntimeConfigError);
  });
});
