import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import { AdminUnauthenticatedError } from "../../src/adapters/admin-api/request-authenticator.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_ID = "22222222-2222-4222-8222-222222222222";
const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const authenticate = vi.fn(async (rawToken: unknown) => {
    if (rawToken !== TOKEN) throw new AdminUnauthenticatedError("invalid token detail");
    return identity;
  });
  const getSession = vi.fn(async () => ({
    principalId: PRINCIPAL_ID,
    roles: ["OWNER_SECURITY_ADMIN"],
    capabilities: [{ key: "player.read", riskTier: 0 as const }],
    scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
    environment: "staging" as const,
  }));
  const searchPlayers = vi.fn(async () => ({ items: [], nextCursor: null }));
  const getPlayer = vi.fn(async (_context: unknown, playerId: string) => ({
    playerId,
    status: "ACTIVE" as const,
  })) as never;

  const server = createAdminApiServer({
    allowedOrigin: ORIGIN,
    authenticator: { authenticate },
    sessionService: { getSession },
    readFacade: { searchPlayers, getPlayer },
  });
  servers.push(server);
  return { server, authenticate, getSession, searchPlayers, getPlayer };
}

describe("Admin API Fastify boundary", () => {
  it("returns 401 when the Cloudflare Access assertion is absent", async () => {
    const { server } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { origin: ORIGIN },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "ADMIN_UNAUTHENTICATED",
        message: "Administrative authentication required",
      },
    });
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(response.body).not.toContain("invalid token detail");
  });

  it("rejects a mismatched browser origin before authentication", async () => {
    const { server, authenticate } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: {
        origin: "https://attacker.example.com",
        "cf-access-jwt-assertion": TOKEN,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("projects the authenticated session with exact-origin CORS and no-store", async () => {
    const { server, getSession } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(getSession).toHaveBeenCalledWith(identity);
    expect(response.json()).toMatchObject({
      principalId: PRINCIPAL_ID,
      roles: ["OWNER_SECURITY_ADMIN"],
      environment: "staging",
    });
  });

  it("rejects client-supplied principal authority as invalid query input", async () => {
    const { server, searchPlayers } = setup();
    const response = await server.inject({
      method: "GET",
      url: `/admin/v1/players?principalId=${PRINCIPAL_ID}`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(400);
    expect(searchPlayers).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_INVALID_INPUT" } });
  });

  it("converts allowlisted search query values and injects only authenticated identity", async () => {
    const { server, searchPlayers } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/players?status=ACTIVE&trainerNamePrefix=Ash&includeSensitive=true&limit=10",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(searchPlayers).toHaveBeenCalledWith(identity, {
      status: "ACTIVE",
      trainerNamePrefix: "Ash",
      includeSensitive: true,
      limit: 10,
    });
  });

  it("takes the player target exclusively from the route and validates its UUID", async () => {
    const { server, getPlayer } = setup();
    const ok = await server.inject({
      method: "GET",
      url: `/admin/v1/players/${PLAYER_ID}?includeSensitive=false`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });
    const invalid = await server.inject({
      method: "GET",
      url: "/admin/v1/players/not-a-uuid",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(ok.statusCode).toBe(200);
    expect(getPlayer).toHaveBeenCalledWith(identity, PLAYER_ID, { includeSensitive: false });
    expect(invalid.statusCode).toBe(400);
  });

  it("sanitizes unexpected handler failures", async () => {
    const { server, searchPlayers } = setup();
    searchPlayers.mockRejectedValueOnce(new Error("postgres://user:secret@db/internal"));

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/players",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "ADMIN_INTERNAL_ERROR", message: "Administrative request failed" },
    });
    expect(response.body).not.toContain("postgres://");
    expect(response.body).not.toContain("secret");
  });

  it("returns 429 before the handler when an authenticated principal exceeds its read budget", async () => {
    const authenticate = vi.fn().mockResolvedValue(identity);
    const getSession = vi.fn().mockResolvedValue({ principalId: PRINCIPAL_ID });
    const searchPlayers = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const getPlayer = vi.fn();
    const consume = vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const dependencies = {
      allowedOrigin: ORIGIN,
      authenticator: { authenticate },
      sessionService: { getSession },
      readFacade: { searchPlayers, getPlayer },
      rateLimiter: { consume },
    };
    const server = createAdminApiServer(dependencies);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/players",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.json()).toMatchObject({
      error: {
        code: "ADMIN_RATE_LIMITED",
        message: "Administrative request rate limit exceeded",
      },
    });
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "player.search",
    });
    expect(searchPlayers).not.toHaveBeenCalled();
  });
});
