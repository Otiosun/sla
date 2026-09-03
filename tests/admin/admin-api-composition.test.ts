import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/platform/config/env.js";
import { createOperationalAdminApi } from "../../src/runtime/compose-admin-api.js";

const databaseUrl = "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test";

describe("createOperationalAdminApi", () => {
  it("returns null when the administrative runtime is disabled", () => {
    const config = loadConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl });

    expect(createOperationalAdminApi({} as Pool, config)).toBeNull();
  });

  it("composes the read-only server when the complete boundary is enabled", async () => {
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: databaseUrl,
      ADMIN_API_ENABLED: "true",
      ADMIN_API_ALLOWED_ORIGIN: "http://localhost:4174",
      ADMIN_ACCESS_TEAM_DOMAIN: "https://pokemon-rpg.cloudflareaccess.com",
      ADMIN_ACCESS_AUDIENCE: "control-center-audience",
    });
    const adminApi = createOperationalAdminApi({} as Pool, config);
    expect(adminApi).not.toBeNull();
    if (adminApi === null) throw new Error("Admin API composition unexpectedly disabled");

    const response = await adminApi.server.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { origin: "http://localhost:4174" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_UNAUTHENTICATED" } });
    await adminApi.close();
  });
});
