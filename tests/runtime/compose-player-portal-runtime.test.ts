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

  it.each(["/v1/hub/player/self", "/v1/hub/player/pokemon"])(
    "keeps %s behind the canonical Hub session",
    async (pathname) => {
      const runtime = composePlayerPortalRuntime(runtimeOptions(pool, 6, null));
      const response = await runtime.handler.handle(
        new Request(`http://player-portal.test${pathname}`),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "UNAUTHENTICATED" });
    },
  );

  it("does not expose gameplay routes through the companion API", async () => {
    const runtime = composePlayerPortalRuntime(runtimeOptions(pool, 7, null));

    for (const pathname of [
      "/v1/hub/world/location",
      "/v1/hub/world/travel",
      "/v1/hub/encounters",
    ]) {
      const response = await runtime.handler.handle(
        new Request(`http://player-portal.test${pathname}`, {
          method: pathname.endsWith("location") ? "GET" : "POST",
        }),
      );
      expect(response.status).toBe(404);
    }
  });
});
