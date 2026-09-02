import { readFileSync } from "node:fs";
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const authenticate = vi.fn().mockResolvedValue(identity);
  const authorize = vi.fn().mockResolvedValue(identity);
  const getSession = vi.fn().mockResolvedValue({ principalId: PRINCIPAL_ID });
  const searchPlayers = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const getPlayer = vi.fn();
  const getPlayerActivityAnalytics = vi.fn().mockResolvedValue({
    asOf: "2026-09-02T12:30:00.000Z",
    activePlayers: {
      last24Hours: 12,
      last7Days: 34,
      last30Days: 56,
    },
    returningPlayers7Days: 7,
  });
  const prepareMutation = vi.fn();
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });

  const server = createAdminApiServer({
    allowedOrigin: ORIGIN,
    authenticator: { authenticate },
    sessionGuard: { authorize },
    sessionService: { getSession },
    readFacade: { searchPlayers, getPlayer, getPlayerActivityAnalytics },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  });
  servers.push(server);
  return { server, getPlayerActivityAnalytics, consume };
}

describe("F8.2 player activity analytics HTTP composition", () => {
  it("exposes one global read-only aggregate route with trusted server context", async () => {
    const { server, getPlayerActivityAnalytics, consume } = setup();

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/analytics/player-activity",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asOf: "2026-09-02T12:30:00.000Z",
      activePlayers: {
        last24Hours: 12,
        last7Days: 34,
        last30Days: 56,
      },
      returningPlayers7Days: 7,
    });
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "player.activity.read",
    });
    expect(getPlayerActivityAnalytics).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
  });

  it("rejects arbitrary analytics windows and client authority fields", async () => {
    const { server, getPlayerActivityAnalytics } = setup();

    for (const query of ["window=90d", "principalId=attacker", "environment=production"]) {
      const response = await server.inject({
        method: "GET",
        url: `/admin/v1/analytics/player-activity?${query}`,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "ADMIN_INVALID_INPUT" } });
    }

    expect(getPlayerActivityAnalytics).not.toHaveBeenCalled();
  });

  it("wires the feature through the operational compose without modifying Phase12", () => {
    const compositionSource = readFileSync(
      new URL("../../src/runtime/compose-admin-api.ts", import.meta.url),
      "utf8",
    );
    const phase12Source = readFileSync(
      new URL("../../src/modules/admin/definitions.ts", import.meta.url),
      "utf8",
    );

    expect(compositionSource).toContain("registerPlayerActivityAnalyticsRead");
    expect(compositionSource).toContain("PlayerActivityAnalyticsService");
    expect(compositionSource).toContain("PostgresPlayerActivityAnalyticsRepository");
    expect(compositionSource).toContain("playerActivityAnalyticsReadService");
    expect(phase12Source).not.toContain("player.activity.read");
  });
});
