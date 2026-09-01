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
    issuedAt: new Date("2026-08-31T15:00:00.000Z"),
    notBefore: new Date("2026-08-31T15:00:00.000Z"),
    expiresAt: new Date("2026-08-31T16:00:00.000Z"),
  },
};

const unpublished = [
  {
    releaseId: "33333333-3333-4333-8333-333333333333",
    releaseNo: "92",
    releaseName: "Kanto balance pass",
    status: "DRAFT" as const,
    workflowState: "EDITING" as const,
    revision: "3",
    parentReleaseId: null,
    createdAt: "2026-08-31T22:00:00.000Z",
    validatedAt: null,
    recordedChangeCount: "3",
    lastChangedAt: "2026-08-31T22:15:00.000Z",
  },
];

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const listUnpublishedContent = vi.fn(async () => unpublished);
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  const dependencies = {
    allowedOrigin: ORIGIN,
    authenticator: { authenticate: vi.fn(async () => identity) },
    sessionGuard: { authorize: vi.fn(async () => identity) },
    sessionService: {
      getSession: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        roles: ["CONTENT_EDITOR"],
        capabilities: [{ key: "content.draft.edit", riskTier: 3 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        environment: "staging" as const,
      })),
    },
    readFacade: {
      searchPlayers: vi.fn(async () => ({ items: [], nextCursor: null })),
      getPlayer: vi.fn(),
      searchContent: vi.fn(async () => ({ items: [], nextCursor: null })),
      listUnpublishedContent,
    },
    mutationFacade: { prepareMutation: vi.fn() },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, listUnpublishedContent, consume };
}

describe("Admin API unpublished content state", () => {
  it("exposes unpublished content as a GET-only server-owned read", async () => {
    const { server, listUnpublishedContent, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/content/unpublished",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(unpublished);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "content.search",
    });
    expect(listUnpublishedContent).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each(["principalId", "environment", "roles", "capabilities", "scopes"] as const)(
    "rejects client-supplied authority field %s",
    async (field) => {
      const { server, listUnpublishedContent } = setup();
      const response = await server.inject({
        method: "GET",
        url: `/admin/v1/content/unpublished?${field}=attacker-controlled`,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
      expect(listUnpublishedContent).not.toHaveBeenCalled();
    },
  );
});
