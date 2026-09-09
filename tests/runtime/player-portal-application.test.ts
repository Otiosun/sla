import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPlayerPortalApplication } from "../../src/runtime/start-player-portal-application.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for Player Portal application tests");
  return value;
})();

describe("Player Portal application", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("serves health and keeps player routes protected over a real TCP listener", async () => {
    const application = await startPlayerPortalApplication({
      pool,
      runtimeConfig: {
        host: "127.0.0.1",
        port: 0,
        sessionSigningKey: Buffer.alloc(32, 9),
        deploymentRevision: "c".repeat(40),
      },
    });

    try {
      const health = await fetch(`http://127.0.0.1:${application.port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({
        status: "ok",
        service: "pokemon-player-portal-api",
        revision: "c".repeat(40),
      });

      const self = await fetch(`http://127.0.0.1:${application.port}/v1/hub/player/self`);
      expect(self.status).toBe(401);
      await expect(self.json()).resolves.toEqual({ error: "UNAUTHENTICATED" });
    } finally {
      await application.close();
    }
  });
});
