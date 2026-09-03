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

function suppressedEncounters() {
  return {
    created: { suppressed: true },
    closures: { suppressed: true },
  } as const;
}

function setup() {
  const getGameplayAnalytics = vi.fn().mockResolvedValue({
    asOf: "2026-09-02T12:30:00.000Z",
    windows: [
      {
        window: "24h",
        encounters: suppressedEncounters(),
        captures: { suppressed: true },
        trainerProgression: { suppressed: true },
      },
      {
        window: "7d",
        encounters: suppressedEncounters(),
        captures: { suppressed: true },
        trainerProgression: { suppressed: true },
      },
      {
        window: "30d",
        encounters: suppressedEncounters(),
        captures: { suppressed: true },
        trainerProgression: { suppressed: true },
      },
    ],
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
      getGameplayAnalytics,
    },
    mutationFacade: { prepareMutation: vi.fn() },
    rateLimiter: { consume },
  });
  servers.push(server);
  return { server, getGameplayAnalytics, consume };
}

describe("F8.4 gameplay analytics HTTP composition", () => {
  it("exposes one bounded global read with trusted server context", async () => {
    const { server, getGameplayAnalytics, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/analytics/gameplay",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      asOf: "2026-09-02T12:30:00.000Z",
      windows: [
        {
          window: "24h",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
        {
          window: "7d",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
        {
          window: "30d",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
      ],
    });
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "gameplay.analytics.read",
    });
    expect(getGameplayAnalytics).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
  });

  it("rejects arbitrary windows and client-owned authority", async () => {
    const { server, getGameplayAnalytics } = setup();
    for (const query of ["window=7d", "principalId=attacker", "environment=production"]) {
      const response = await server.inject({
        method: "GET",
        url: `/admin/v1/analytics/gameplay?${query}`,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "ADMIN_INVALID_INPUT" } });
    }
    expect(getGameplayAnalytics).not.toHaveBeenCalled();
  });

  it("fails closed if runtime output contains an unexpected key", async () => {
    const { server, getGameplayAnalytics } = setup();
    getGameplayAnalytics.mockResolvedValueOnce({
      asOf: "2026-09-02T12:30:00.000Z",
      windows: [
        {
          window: "24h",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
        {
          window: "7d",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
        {
          window: "30d",
          encounters: suppressedEncounters(),
          captures: { suppressed: true },
          trainerProgression: { suppressed: true },
        },
      ],
      secretDebug: "must-not-leak",
    } as never);

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/analytics/gameplay",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_INTERNAL_ERROR" } });
    expect(response.body).not.toContain("secretDebug");
    expect(response.body).not.toContain("must-not-leak");
  });
});
