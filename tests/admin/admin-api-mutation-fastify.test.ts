import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import { AdminMutationFacade } from "../../src/adapters/admin-api/mutation-facade.js";
import { AdminUnauthenticatedError } from "../../src/adapters/admin-api/request-authenticator.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const CSRF_HEADER = "x-control-center-csrf";
const CSRF_VALUE = "1";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const SUPPORT_ROLE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_CORRELATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REASON = "Grant support role for HTTP boundary proof";
const IDEMPOTENCY_KEY = "role-assign-proof-0001";

const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: 1_700_000_000,
    notBefore: 1_700_000_000,
    expiresAt: 1_700_003_600,
  },
};

const clientBody = {
  operationType: "admin.role.assign",
  input: { principalId: TARGET_ADMIN_ID, roleId: SUPPORT_ROLE_ID },
  reason: REASON,
  expectedRevision: "0",
  idempotencyKey: IDEMPOTENCY_KEY,
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
  const getSession = vi.fn();
  const searchPlayers = vi.fn();
  const getPlayer = vi.fn();
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  const prepareMutationEndpoint = vi.fn(async (rawRequest: unknown) => {
    const request = rawRequest as {
      principalId: string;
      correlationId: string;
      expectedRevision: bigint;
    };
    return {
      operation: {
        id: OPERATION_ID,
        principalId: request.principalId,
        capabilityKey: "admin.role.assign",
        operationType: "admin.role.assign",
        targetType: "ADMIN_PRINCIPAL",
        targetId: TARGET_ADMIN_ID,
        riskTier: 4 as const,
        authorizationMode: "GLOBAL_ONLY" as const,
        status: "VALIDATED" as const,
        reason: REASON,
        expectedRevision: request.expectedRevision,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestFingerprint: "f".repeat(64),
        input: { principalId: TARGET_ADMIN_ID, roleId: SUPPORT_ROLE_ID },
        result: null,
        correlationId: request.correlationId,
        policy: {
          version: 1,
          requiresReason: true,
          requiresExpectedRevision: true,
          requiresSimulation: true,
          requiresConfirmation: true,
          requiredApprovals: 1,
        },
        revision: 0n,
        appliedAt: null,
      },
      replayed: false,
    };
  });
  const mutationFacade = new AdminMutationFacade({ prepareMutation: prepareMutationEndpoint });

  const dependencies = {
    allowedOrigin: ORIGIN,
    authenticator: { authenticate },
    sessionService: { getSession },
    readFacade: { searchPlayers, getPlayer },
    mutationFacade,
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, authenticate, consume, prepareMutationEndpoint };
}

describe("Admin API mutation preparation HTTP boundary", () => {
  it("prepares an operation from trusted server context and returns a JSON-safe projection", async () => {
    const { server, consume, prepareMutationEndpoint } = setup();
    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": TOKEN,
        "x-correlation-id": CLIENT_CORRELATION_ID,
        [CSRF_HEADER]: CSRF_VALUE,
      },
      payload: clientBody,
    });

    expect(response.statusCode).toBe(200);
    const correlationId = response.headers["x-correlation-id"];
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(correlationId).not.toBe(CLIENT_CORRELATION_ID);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "mutation.prepare",
    });
    expect(prepareMutationEndpoint).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "admin.role.assign",
      input: { principalId: TARGET_ADMIN_ID, roleId: SUPPORT_ROLE_ID },
      reason: REASON,
      expectedRevision: 0n,
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId,
    });
    expect(response.json()).toEqual({
      operation: {
        id: OPERATION_ID,
        operationType: "admin.role.assign",
        target: { type: "ADMIN_PRINCIPAL", id: TARGET_ADMIN_ID },
        riskTier: 4,
        authorizationMode: "GLOBAL_ONLY",
        status: "VALIDATED",
        reason: REASON,
        expectedRevision: "0",
        correlationId,
        policy: {
          version: 1,
          requiresReason: true,
          requiresExpectedRevision: true,
          requiresSimulation: true,
          requiresConfirmation: true,
          requiredApprovals: 1,
        },
        revision: "0",
      },
      replayed: false,
    });
  });

  it("rejects a mutation request without the exact browser Origin before authentication", async () => {
    const { server, authenticate, prepareMutationEndpoint } = setup();
    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        "cf-access-jwt-assertion": TOKEN,
        [CSRF_HEADER]: CSRF_VALUE,
      },
      payload: clientBody,
    });

    expect(response.statusCode).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect(prepareMutationEndpoint).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong"])(
    "rejects a mutation with missing/invalid CSRF header before authentication (%s)",
    async (csrfValue) => {
      const { server, authenticate, consume, prepareMutationEndpoint } = setup();
      const headers: Record<string, string> = {
        origin: ORIGIN,
        "cf-access-jwt-assertion": TOKEN,
      };
      if (csrfValue !== undefined) headers[CSRF_HEADER] = csrfValue;

      const response = await server.inject({
        method: "POST",
        url: "/admin/v1/operations/prepare",
        headers,
        payload: clientBody,
      });

      expect(response.statusCode).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(prepareMutationEndpoint).not.toHaveBeenCalled();
    },
  );

  it.each([
    "principalId",
    "correlationId",
    "environment",
    "roles",
    "capabilities",
    "scopes",
  ] as const)("rejects client-supplied mutation authority field %s", async (authorityField) => {
    const { server, prepareMutationEndpoint } = setup();
    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": TOKEN,
        [CSRF_HEADER]: CSRF_VALUE,
      },
      payload: { ...clientBody, [authorityField]: "attacker-controlled" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "ADMIN_INVALID_INPUT" } });
    expect(prepareMutationEndpoint).not.toHaveBeenCalled();
  });

  it("answers the exact-origin mutation preflight without authenticating", async () => {
    const { server, authenticate } = setup();
    const response = await server.inject({
      method: "OPTIONS",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": `content-type,${CSRF_HEADER}`,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toBe("POST");
    expect(response.headers["access-control-allow-headers"]).toBe(`content-type,${CSRF_HEADER}`);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
