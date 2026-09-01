import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import type { AdminOperationAuditView } from "../../src/modules/admin/admin-operation-audit-read-contracts.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-09-01T10:00:00.000Z"),
    notBefore: new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: new Date("2026-09-01T11:00:00.000Z"),
  },
};

const snapshot: AdminOperationAuditView = {
  operation: {
    id: OPERATION_ID,
    principalId: PRINCIPAL_ID,
    capabilityKey: "admin.role.assign",
    operationType: "admin.role.assign",
    targetType: "ADMIN_PRINCIPAL",
    targetId: "44444444-4444-4444-8444-444444444444",
    riskTier: 4,
    status: "APPLIED",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    reasonRecorded: true,
    expectedRevision: "7",
    revision: "4",
    policy: {
      version: 1,
      requiresReason: true,
      requiresExpectedRevision: true,
      requiresSimulation: true,
      requiresConfirmation: true,
      requiredApprovals: 1,
    },
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:04:00.000Z",
    appliedAt: "2026-09-01T12:04:00.000Z",
  },
  timeline: [],
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const getAdminOperationAudit = vi.fn(async () => snapshot);
  const prepareMutation = vi.fn();
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  const dependencies = {
    allowedOrigin: ORIGIN,
    authenticator: { authenticate: vi.fn(async () => identity) },
    sessionGuard: { authorize: vi.fn(async () => identity) },
    sessionService: {
      getSession: vi.fn(async () => ({
        principalId: PRINCIPAL_ID,
        roles: ["SENIOR_ADMIN"],
        capabilities: [{ key: "admin_operation.read", riskTier: 0 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        environment: "staging" as const,
      })),
    },
    readFacade: {
      searchPlayers: vi.fn(async () => ({ items: [], nextCursor: null })),
      getPlayer: vi.fn(),
      getAdminOperationAudit,
    },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, getAdminOperationAudit, prepareMutation, consume };
}

describe("Admin API operation audit reconstruction read", () => {
  it("exposes an authenticated exact-operation GET with a dedicated limiter", async () => {
    const { server, getAdminOperationAudit, prepareMutation, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: `/admin/v1/operations/${OPERATION_ID}/audit`,
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "admin_operation.read",
    });
    expect(getAdminOperationAudit).toHaveBeenCalledWith(
      {
        principalId: PRINCIPAL_ID,
        environment: "staging",
        correlationId: response.headers["x-correlation-id"],
      },
      OPERATION_ID,
    );
    expect(prepareMutation).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects malformed operation ids and all query expansion before the facade", async () => {
    const { server, getAdminOperationAudit } = setup();
    for (const url of [
      "/admin/v1/operations/not-a-uuid/audit",
      `/admin/v1/operations/${OPERATION_ID}/audit?includeRaw=true`,
      `/admin/v1/operations/${OPERATION_ID}/audit?environment=production`,
    ]) {
      const response = await server.inject({
        method: "GET",
        url,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(getAdminOperationAudit).not.toHaveBeenCalled();
  });
});
