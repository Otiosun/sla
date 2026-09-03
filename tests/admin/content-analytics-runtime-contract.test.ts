import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ContentAnalyticsService } from "../../src/modules/admin/content-analytics-service.js";
import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLE_CAPABILITIES,
} from "../../src/modules/admin/registry-catalog.js";
import { loadConfig } from "../../src/platform/config/env.js";

const capture = vi.hoisted(() => ({ dependencies: null as unknown }));

vi.mock("../../src/adapters/admin-api/fastify-server.js", () => ({
  createAdminApiServer: vi.fn((dependencies: unknown) => {
    capture.dependencies = dependencies;
    return {
      listen: vi.fn(async () => "http://127.0.0.1:0"),
      close: vi.fn(async () => undefined),
    };
  }),
}));

import { createOperationalAdminApi } from "../../src/runtime/compose-admin-api.js";

const databaseUrl = "postgresql://pokemon:test@localhost:5432/pokemon_rpg_test";
const CONTENT_ANALYTICS_CAPABILITY = "content.analytics.read";

function roleCapabilities(role: string): readonly string[] {
  return (ADMIN_ROLE_CAPABILITIES[role] ?? []) as readonly string[];
}

describe("F8.4 content analytics runtime contract", () => {
  it("registers one R0 capability only for operational roles that need the aggregate view", () => {
    const capabilities = ADMIN_CAPABILITIES as readonly (readonly [string, number])[];
    expect(capabilities).toContainEqual([CONTENT_ANALYTICS_CAPABILITY, 0]);

    expect(roleCapabilities("SUPPORT")).toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("GAME_MASTER")).toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("SENIOR_ADMIN")).toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("OWNER_SECURITY_ADMIN")).toContain(CONTENT_ANALYTICS_CAPABILITY);

    expect(roleCapabilities("CONTENT_EDITOR")).not.toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("CONTENT_PUBLISHER")).not.toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("ECONOMY_ADMIN")).not.toContain(CONTENT_ANALYTICS_CAPABILITY);
    expect(roleCapabilities("POKEMON_ADMIN")).not.toContain(CONTENT_ANALYTICS_CAPABILITY);
  });

  it("injects the content analytics service into the operational AdminReadFacade", () => {
    capture.dependencies = null;
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

    const dependencies = capture.dependencies as {
      readonly readFacade: { readonly contentAnalytics?: unknown };
    };
    expect(dependencies.readFacade.contentAnalytics).toBeInstanceOf(ContentAnalyticsService);
  });
});
