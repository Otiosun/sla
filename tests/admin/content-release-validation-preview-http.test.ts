import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

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

const report = {
  valid: false,
  issues: [
    {
      code: "FORM_SPECIES_MISSING",
      path: "forms.0.speciesId",
      message: "Form references a species absent from this release",
    },
  ],
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const previewContentReleaseValidation = vi.fn(async () => report);
  const prepareMutation = vi.fn();
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
      diffContentRelease: vi.fn(),
      previewContentReleaseValidation,
    },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, previewContentReleaseValidation, prepareMutation, consume };
}

describe("Admin API content release validation preview", () => {
  it("exposes authoritative blockers through a strict read-only GET", async () => {
    const { server, previewContentReleaseValidation, prepareMutation, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: `/admin/v1/content/releases/${RELEASE_ID}/validation`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ releaseId: RELEASE_ID, ...report });
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "content.search",
    });
    expect(previewContentReleaseValidation).toHaveBeenCalledWith(
      {
        principalId: PRINCIPAL_ID,
        environment: "staging",
        correlationId: response.headers["x-correlation-id"],
      },
      RELEASE_ID,
    );
    expect(prepareMutation).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects query keys instead of accepting browser-controlled validation options", async () => {
    const { server, previewContentReleaseValidation } = setup();
    const response = await server.inject({
      method: "GET",
      url: `/admin/v1/content/releases/${RELEASE_ID}/validation?force=true`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(400);
    expect(previewContentReleaseValidation).not.toHaveBeenCalled();
  });
});
