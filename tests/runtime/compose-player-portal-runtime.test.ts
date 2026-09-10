import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composePlayerPortalRuntime } from "../../src/runtime/compose-player-portal-runtime.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for runtime composition tests");
  return value;
})();

function runtimeOptions(pool: Pool, signingByte: number, revision: string | null) {
  return {
    pool,
    sessionSigningKey: Buffer.alloc(32, signingByte),
    encounterRngKey: Buffer.alloc(32, signingByte + 10),
    encounterRngKeyVersion: 1,
    deploymentRevision: revision,
  };
}

describe("Player Portal runtime composition", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("exposes a no-store health boundary with the exact deployment revision", async () => {
    const runtime = composePlayerPortalRuntime(runtimeOptions(pool, 5, "b".repeat(40)));

    const response = await runtime.handler.handle(new Request("http://player-portal.test/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "pokemon-player-portal-api",
      revision: "b".repeat(40),
    });
  });

  it.each(["/v1/hub/player/self", "/v1/hub/world/location", "/v1/hub/encounters"])(
    "keeps %s behind the canonical Hub session",
    async (pathname) => {
      const runtime = composePlayerPortalRuntime(runtimeOptions(pool, 6, null));

      const response = await runtime.handler.handle(
        new Request(`http://player-portal.test${pathname}`, {
          ...(pathname === "/v1/hub/encounters"
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "test-encounter" }),
              }
            : {}),
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "UNAUTHENTICATED" });
    },
  );

  it("delegates malformed ticket exchange to the canonical Player Portal handler", async () => {
    const runtime = composePlayerPortalRuntime(runtimeOptions(pool, 7, null));

    const response = await runtime.handler.handle(
      new Request("http://player-portal.test/v1/hub/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: "invalid" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "VALIDATION_FAILED" });
  });
});
