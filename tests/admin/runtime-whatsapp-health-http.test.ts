import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";

const TOKEN = "x".repeat(64);
const ORIGIN = "https://admin-staging.example.com";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_REVISION = "b".repeat(40);

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

const runtimeHealth = {
  environment: "staging" as const,
  runtime: {
    providerState: "CONNECTED" as const,
    deploymentRevision: DEPLOYMENT_REVISION,
    startedAt: "2026-09-01T09:55:00.000Z",
    lastConnectedAt: "2026-09-01T09:56:00.000Z",
    lastHeartbeatAt: "2026-09-01T10:05:00.000Z",
    lastDisconnectAt: null,
    stoppedAt: null,
  },
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const getRuntimeWhatsappHealth = vi.fn(async () => runtimeHealth);
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
        capabilities: [{ key: "runtime.health.read", riskTier: 0 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        environment: "staging" as const,
      })),
    },
    readFacade: {
      searchPlayers: vi.fn(async () => ({ items: [], nextCursor: null })),
      getPlayer: vi.fn(),
      getRuntimeWhatsappHealth,
    },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, getRuntimeWhatsappHealth, prepareMutation, consume };
}

describe("Admin API runtime WhatsApp health", () => {
  it("exposes a strict authenticated read using the server-owned environment", async () => {
    const { server, getRuntimeWhatsappHealth, prepareMutation, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/runtime/whatsapp/health",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(runtimeHealth);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "runtime.health.read",
    });
    expect(getRuntimeWhatsappHealth).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
    expect(prepareMutation).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects query keys instead of accepting browser-selected environment or instance", async () => {
    const { server, getRuntimeWhatsappHealth } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/runtime/whatsapp/health?environment=production",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(400);
    expect(getRuntimeWhatsappHealth).not.toHaveBeenCalled();
  });
});
