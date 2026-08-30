import { describe, expect, it } from "vitest";
import {
  createReleaseRuntimeRegistration,
  ReleaseRuntimeRegistrationError,
} from "../../src/runtime/release-runtime-registration.js";

const revision = "1234567890abcdef1234567890abcdef12345678";
const instanceId = "123e4567-e89b-42d3-a456-426614174000";

describe("release runtime registration boundary", () => {
  it("creates exact durable identity only for staging and production", () => {
    expect(
      createReleaseRuntimeRegistration({
        appEnv: "staging",
        deploymentRevision: revision,
        whatsappSessionKey: "staging-main",
        instanceId,
      }),
    ).toEqual({
      instanceId,
      environment: "staging",
      deploymentRevision: revision,
      whatsappSessionKey: "staging-main",
    });

    expect(
      createReleaseRuntimeRegistration({
        appEnv: "production",
        deploymentRevision: revision,
        whatsappSessionKey: "prod-main",
        instanceId,
      })?.environment,
    ).toBe("production");
  });

  it("does not create fake deployment evidence in development or test", () => {
    for (const appEnv of ["development", "test"] as const) {
      expect(
        createReleaseRuntimeRegistration({
          appEnv,
          deploymentRevision: null,
          whatsappSessionKey: "local-session",
          instanceId,
        }),
      ).toBeNull();
    }
  });

  it("fails closed when release identity and environment disagree", () => {
    expect(() =>
      createReleaseRuntimeRegistration({
        appEnv: "staging",
        deploymentRevision: null,
        whatsappSessionKey: "staging-main",
        instanceId,
      }),
    ).toThrow(ReleaseRuntimeRegistrationError);

    expect(() =>
      createReleaseRuntimeRegistration({
        appEnv: "development",
        deploymentRevision: revision,
        whatsappSessionKey: "local-session",
        instanceId,
      }),
    ).toThrow(ReleaseRuntimeRegistrationError);
  });
});
