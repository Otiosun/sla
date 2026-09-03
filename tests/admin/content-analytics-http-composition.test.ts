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
    issuedAt: new Date("2026-09-03T12:00:00.000Z"),
    notBefore: new Date("2026-09-03T12:00:00.000Z"),
    expiresAt: new Date("2026-09-03T13:00:00.000Z"),
  },
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function setup() {
  const getContentAnalytics = vi.fn().mockResolvedValue({
    asOf: "2026-09-03T12:30:00.000Z",
    window: "30d",
    encounters: { created: "12", closed: "9" },
    captures: { attemptsCreated: "8", captured: "5", failed: "2" },
    progression: { xpAwards: "22", xpAwarded: "12500", evolutions: "3" },
  });
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  const server = createAdminApiServer({
    allowedOrigin: ORIGIN,
    authenticator: { authenticate: vi.fn().mockResolvedValue(identity) },
    sessionGuard: { authorize: vi.fn().mockResolvedValue(identity) },
    sessionService: { getSession: vi.fn().mockResolvedValue({ principalId: PRINCIPAL_ID }) },
    readFacade: {
      searchPlayers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getPlayer: vi.fn(),
      getContentAnalytics,
    },
    mutationFacade: { prepareMutation: vi.fn() },
    rateLimiter: { consume },
  });
  servers.push(server);
  return { server, getContentAnalytics, consume };
}

describe("F8.4 content analytics HTTP composition", () => {
  it("exposes one bounded global read with trusted server context", async () => {
    const { server, getContentAnalytics, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/analytics/content",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      asOf: "2026-09-03T12:30:00.000Z",
      window: "30d",
      encounters: { created: "12", closed: "9" },
      captures: { attemptsCreated: "8", captured: "5", failed: "2" },
      progression: { xpAwards: "22", xpAwarded: "12500", evolutions: "3" },
    });
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "content.analytics.read",
    });
    expect(getContentAnalytics).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
  });

  it("rejects arbitrary windows and client-owned authority", async () => {
    const { server, getContentAnalytics } = setup();

    for (const query of ["window=7d", "principalId=attacker", "environment=production"]) {
      const response = await server.inject({
        method: "GET",
        url: `/admin/v1/analytics/content?${query}`,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "ADMIN_INVALID_INPUT" } });
    }

    expect(getContentAnalytics).not.toHaveBeenCalled();
  });
});
