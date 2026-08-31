import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";

const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "x".repeat(64);
const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-08-31T15:00:00.000Z"),
    notBefore: new Date("2026-08-31T15:00:00.000Z"),
    expiresAt: new Date("2026-08-31T18:00:00.000Z"),
  },
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Admin API current-session logout", () => {
  it("revokes the current durable session before returning the fixed Access logout path", async () => {
    const authenticate = vi.fn().mockResolvedValue(identity);
    const authorize = vi.fn().mockResolvedValue(identity);
    const logoutCurrent = vi
      .fn()
      .mockResolvedValue({ logoutPath: "/cdn-cgi/access/logout" as const });
    const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
    const dependencies = {
      allowedOrigin: ORIGIN,
      authenticator: { authenticate },
      sessionGuard: { authorize },
      sessionLogoutService: { logoutCurrent },
      sessionService: { getSession: vi.fn() },
      readFacade: { searchPlayers: vi.fn(), getPlayer: vi.fn() },
      mutationFacade: { prepareMutation: vi.fn() },
      rateLimiter: { consume },
    };
    const server = createAdminApiServer(dependencies);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/session/logout",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": TOKEN,
        "x-control-center-csrf": "1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(TOKEN);
    expect(authorize).toHaveBeenCalledWith(identity);
    expect(logoutCurrent).toHaveBeenCalledWith(identity);
    expect(consume).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ logoutPath: "/cdn-cgi/access/logout" });
  });
});
