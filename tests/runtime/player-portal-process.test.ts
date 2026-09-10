import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/platform/config/env.js";
import { startPlayerPortalProcess } from "../../src/runtime/start-player-portal-process.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for Player Portal process tests");
  return value;
})();

function appConfig(): AppConfig {
  return {
    appEnv: "test",
    logLevel: "warn",
    databaseUrl,
    migratorDatabaseUrl: null,
    databasePoolMax: 2,
    databaseConnectTimeoutMs: 5_000,
    databaseIdleTimeoutMs: 30_000,
    databaseQueryTimeoutMs: 10_000,
    databaseStatementTimeoutMs: 10_000,
    databaseIdleInTransactionTimeoutMs: 15_000,
  };
}

describe("Player Portal process", () => {
  it("owns the database pool and HTTP listener for a clean process lifecycle", async () => {
    const runtime = await startPlayerPortalProcess({
      appConfig: appConfig(),
      runtimeConfig: {
        host: "127.0.0.1",
        port: 0,
        sessionSigningKey: Buffer.alloc(32, 10),
        encounterRngKey: Buffer.alloc(32, 14),
        encounterRngKeyVersion: 1,
        deploymentRevision: "d".repeat(40),
      },
    });

    const url = `http://127.0.0.1:${runtime.port}/health`;
    const health = await fetch(url);
    expect(health.status).toBe(200);

    await runtime.close();

    await expect(fetch(url)).rejects.toThrow();
  });
});
