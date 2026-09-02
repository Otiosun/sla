import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-09-02T12:00:00.000Z"),
    notBefore: new Date("2026-09-02T12:00:00.000Z"),
    expiresAt: new Date("2026-09-02T13:00:00.000Z"),
  },
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("F8.3 economy analytics output boundary", () => {
  it("fails closed instead of serializing an unexpected field returned by the read facade", async () => {
    const getEconomyAnalytics = vi.fn().mockResolvedValue({
      asOf: "2026-09-02T12:30:00.000Z",
      window: "30d",
      currencies: [],
      currenciesTruncated: false,
      inventory: {
        inflowUnits: "0",
        outflowUnits: "0",
        netFlowUnits: "0",
        totalUnitsHeld: "0",
      },
      anomalies: {
        walletProjectionMismatches: "0",
        inventoryProjectionMismatches: "0",
      },
      secretDebug: "must-never-cross-http-boundary",
    });
    const server = createAdminApiServer({
      allowedOrigin: ORIGIN,
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity) },
      sessionGuard: { authorize: vi.fn().mockResolvedValue(identity) },
      sessionService: { getSession: vi.fn().mockResolvedValue({ principalId: PRINCIPAL_ID }) },
      readFacade: {
        searchPlayers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        getPlayer: vi.fn(),
        getEconomyAnalytics,
      },
      mutationFacade: { prepareMutation: vi.fn() },
      rateLimiter: {
        consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 }),
      },
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/analytics/economy",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_INTERNAL_ERROR" } });
    expect(response.body).not.toContain("secretDebug");
    expect(response.body).not.toContain("must-never-cross-http-boundary");
  });
});
