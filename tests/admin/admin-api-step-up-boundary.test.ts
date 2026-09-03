import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import { AdminUnauthenticatedError } from "../../src/adapters/admin-api/request-authenticator.js";

const ORIGIN = "https://admin-staging.example.com";
const STANDARD_TOKEN = "s".repeat(64);
const PRIVILEGED_TOKEN = "p".repeat(64);
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const identity = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:step-up-proof",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-08-31T18:00:00.000Z"),
    notBefore: new Date("2026-08-31T18:00:00.000Z"),
    expiresAt: new Date("2026-08-31T19:00:00.000Z"),
  },
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const authenticate = vi.fn(async (rawToken: unknown) => {
    if (rawToken !== STANDARD_TOKEN) {
      throw new AdminUnauthenticatedError("standard Access boundary rejected token");
    }
    return identity;
  });
  const privilegedAuthenticate = vi.fn(async (rawToken: unknown) => {
    if (rawToken !== PRIVILEGED_TOKEN) {
      throw new AdminUnauthenticatedError("privileged Access boundary rejected token");
    }
    return identity;
  });
  const authorize = vi.fn(async (context: typeof identity) => context);
  const getSession = vi.fn(async () => ({
    principalId: PRINCIPAL_ID,
    roles: ["OWNER_SECURITY_ADMIN"],
    capabilities: [],
    scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
    environment: "staging" as const,
  }));
  const prepareMutation = vi.fn(async (_context: unknown, _body: unknown) => ({
    operation: {
      id: OPERATION_ID,
      principalId: PRINCIPAL_ID,
      capabilityKey: "admin.session.revoke",
      operationType: "admin.session.revoke_all",
      targetType: "ADMIN_PRINCIPAL",
      targetId: TARGET_ADMIN_ID,
      riskTier: 4 as const,
      authorizationMode: "GLOBAL_ONLY" as const,
      status: "VALIDATED" as const,
      reason: "step-up boundary proof",
      expectedRevision: null,
      idempotencyKey: "step-up-proof-0001",
      requestFingerprint: "f".repeat(64),
      input: { principalId: TARGET_ADMIN_ID },
      result: null,
      correlationId: "44444444-4444-4444-8444-444444444444",
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: true,
        requiresConfirmation: true,
        requiredApprovals: 1,
      },
      revision: 0n,
      appliedAt: null,
    },
    replayed: false,
  }));
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });

  const server = createAdminApiServer({
    allowedOrigin: ORIGIN,
    authenticator: { authenticate },
    privilegedAuthenticator: { authenticate: privilegedAuthenticate },
    sessionGuard: { authorize },
    sessionService: { getSession },
    readFacade: {
      searchPlayers: vi.fn(),
      getPlayer: vi.fn(),
    },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  } as never);
  servers.push(server);

  return { server, authenticate, privilegedAuthenticate, prepareMutation };
}

describe("Admin API Access step-up boundary", () => {
  it("keeps ordinary reads on the standard Access application", async () => {
    const { server, authenticate, privilegedAuthenticate } = setup();

    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": STANDARD_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(STANDARD_TOKEN);
    expect(privilegedAuthenticate).not.toHaveBeenCalled();
  });

  it("rejects PREPARE with a token accepted only by the standard Access application", async () => {
    const { server, authenticate, privilegedAuthenticate, prepareMutation } = setup();

    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": STANDARD_TOKEN,
        "x-control-center-csrf": "1",
      },
      payload: {
        operationType: "admin.session.revoke_all",
        input: { principalId: TARGET_ADMIN_ID },
        reason: "step-up boundary proof",
        idempotencyKey: "step-up-proof-0001",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(privilegedAuthenticate).toHaveBeenCalledWith(STANDARD_TOKEN);
    expect(authenticate).not.toHaveBeenCalled();
    expect(prepareMutation).not.toHaveBeenCalled();
  });

  it("accepts PREPARE only through the privileged Access application", async () => {
    const { server, authenticate, privilegedAuthenticate, prepareMutation } = setup();

    const response = await server.inject({
      method: "POST",
      url: "/admin/v1/operations/prepare",
      headers: {
        origin: ORIGIN,
        "cf-access-jwt-assertion": PRIVILEGED_TOKEN,
        "x-control-center-csrf": "1",
      },
      payload: {
        operationType: "admin.session.revoke_all",
        input: { principalId: TARGET_ADMIN_ID },
        reason: "step-up boundary proof",
        idempotencyKey: "step-up-proof-0001",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(privilegedAuthenticate).toHaveBeenCalledWith(PRIVILEGED_TOKEN);
    expect(authenticate).not.toHaveBeenCalled();
    expect(prepareMutation).toHaveBeenCalledOnce();
  });
});
