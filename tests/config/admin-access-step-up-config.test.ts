import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/platform/config/env.js";

const baseAdminEnv = {
  APP_ENV: "staging",
  DATABASE_URL: "postgresql://runtime:test@localhost:5432/pokemon_rpg",
  ADMIN_API_ENABLED: "true",
  ADMIN_API_ALLOWED_ORIGIN: "https://admin-staging.example.com",
  ADMIN_ACCESS_TEAM_DOMAIN: "https://pokemon-rpg.cloudflareaccess.com",
  ADMIN_ACCESS_AUDIENCE: "control-center-standard-audience",
} as const;

describe("Admin Access privileged audience configuration", () => {
  it("fails closed in staging when the privileged Access audience is absent", () => {
    expect(() => loadConfig(baseAdminEnv)).toThrow(/privileged Access audience/i);
  });

  it("rejects a privileged Access audience that is identical to the standard audience", () => {
    expect(() =>
      loadConfig({
        ...baseAdminEnv,
        ADMIN_ACCESS_PRIVILEGED_AUDIENCE: "control-center-standard-audience",
      }),
    ).toThrow(/must be distinct/i);
  });

  it("loads a distinct privileged Access audience for the mutation step-up boundary", () => {
    const config = loadConfig({
      ...baseAdminEnv,
      ADMIN_ACCESS_PRIVILEGED_AUDIENCE: "control-center-privileged-audience",
    });

    expect(
      (config as unknown as Record<string, unknown>).adminAccessPrivilegedAudience,
    ).toBe("control-center-privileged-audience");
  });
});
