import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const FROM_RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const TO_RELEASE_ID = "33333333-3333-4333-8333-333333333333";

const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-08-31T15:00:00.000Z"),
    notBefore: new Date("2026-08-31T15:00:00.000Z"),
    expiresAt: new Date("2026-08-31T16:00:00.000Z"),
  },
};

const diff = {
  fromReleaseId: FROM_RELEASE_ID,
  toReleaseId: TO_RELEASE_ID,
  sections: [
    { category: "species", added: 1, removed: 0, changed: 2 },
    { category: "moves", added: 0, removed: 1, changed: 0 },
  ],
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const diffContentRelease = vi.fn(async () => diff);
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  const dependencies = {
    allowedOrigin: ORIGIN,
    authenticator: { authenticate: vi.fn(async () => identity) },
    sessionGuard: { authorize: vi.fn(async () => identity) },
    sessionService: {
      getSession: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        roles: ["CONTENT_EDITOR"],
        capabilities: [{ key: "content.validate", riskTier: 3 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        environment: "staging" as const,
      })),
    },
    readFacade: {
      searchPlayers: vi.fn(async () => ({ items: [], nextCursor: null })),
      getPlayer: vi.fn(),
      searchContent: vi.fn(async () => ({ items: [], nextCursor: null })),
      listUnpublishedContent: vi.fn(async () => []),
      diffContentRelease,
    },
    mutationFacade: { prepareMutation: vi.fn() },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, diffContentRelease, consume };
}

describe("Admin API content release diff", () => {
  it("exposes a strict GET-only human release diff with server-owned authority", async () => {
    const { server, diffContentRelease, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: `/admin/v1/content/releases/diff?fromReleaseId=${FROM_RELEASE_ID}&toReleaseId=${TO_RELEASE_ID}`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(diff);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "content.search",
    });
    expect(diffContentRelease).toHaveBeenCalledWith(
      {
        principalId: PRINCIPAL_ID,
        environment: "staging",
        correlationId: response.headers["x-correlation-id"],
      },
      { fromReleaseId: FROM_RELEASE_ID, toReleaseId: TO_RELEASE_ID },
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
