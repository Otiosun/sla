import { describe, expect, it } from "vitest";
import {
  expectedInitialAdminBootstrapConfirmation,
  InitialAdminBootstrapConfigError,
  loadInitialAdminBootstrapConfig,
} from "../../src/operations/initial-admin-bootstrap-config.js";

const REVISION = "a".repeat(40);

function validEnv(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "staging",
    DATABASE_URL: "postgresql://runtime:runtime-password@localhost:5432/pokemon_rpg",
    MIGRATOR_DATABASE_URL:
      "postgresql://migrator:migrator-password@localhost:5432/pokemon_rpg",
    DEPLOY_REVISION: REVISION,
    ADMIN_BOOTSTRAP_IDENTITY_REF: "proof:owner",
    ADMIN_BOOTSTRAP_CONFIRMATION: expectedInitialAdminBootstrapConfirmation("staging", REVISION),
  };
}

describe("initial admin bootstrap config", () => {
  it("accepts a release-bound bootstrap configuration with separate database roles", () => {
    const config = loadInitialAdminBootstrapConfig(validEnv());
    expect(config.appEnv).toBe("staging");
    expect(config.deploymentRevision).toBe(REVISION);
    expect(config.identityRef).toBe("proof:owner");
  });

  it("rejects non-release environments", () => {
    const env = validEnv();
    env.APP_ENV = "test";
    expect(() => loadInitialAdminBootstrapConfig(env)).toThrow(InitialAdminBootstrapConfigError);
  });

  it("rejects shared runtime and migrator roles", () => {
    const env = validEnv();
    env.MIGRATOR_DATABASE_URL = env.DATABASE_URL;
    expect(() => loadInitialAdminBootstrapConfig(env)).toThrow(
      "Runtime and migrator PostgreSQL roles must be distinct",
    );
  });

  it("rejects credentials that point at different databases", () => {
    const env = validEnv();
    env.MIGRATOR_DATABASE_URL =
      "postgresql://migrator:migrator-password@localhost:5432/other_database";
    expect(() => loadInitialAdminBootstrapConfig(env)).toThrow(
      "Runtime and migrator credentials must target the same database",
    );
  });

  it("rejects an identity without an explicit provider namespace", () => {
    const env = validEnv();
    env.ADMIN_BOOTSTRAP_IDENTITY_REF = "owner";
    expect(() => loadInitialAdminBootstrapConfig(env)).toThrow(InitialAdminBootstrapConfigError);
  });

  it("rejects a confirmation copied from another environment or revision", () => {
    const env = validEnv();
    env.ADMIN_BOOTSTRAP_CONFIRMATION = expectedInitialAdminBootstrapConfirmation(
      "production",
      REVISION,
    );
    expect(() => loadInitialAdminBootstrapConfig(env)).toThrow(
      "ADMIN_BOOTSTRAP_CONFIRMATION does not match the environment and deploy revision",
    );
  });
});
