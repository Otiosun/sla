import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiServer } from "../../src/adapters/admin-api/fastify-server.js";
import type { IncidentCenterView } from "../../src/modules/admin/incident-center-read-contracts.js";

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
    issuedAt: new Date("2026-09-01T10:00:00.000Z"),
    notBefore: new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: new Date("2026-09-01T11:00:00.000Z"),
  },
};

const snapshot: IncidentCenterView = {
  signals: [
    {
      source: "OUTBOX",
      id: "33333333-3333-4333-8333-333333333333",
      correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "DEAD",
      kind: "OUTBOX_MESSAGE",
      targetType: null,
      targetId: null,
      riskTier: null,
      attempts: 8,
      occurredAt: "2026-09-01T13:00:00.000Z",
      runbook: {
        key: "outbox-dead-letter",
        title: "Mensagem em dead-letter",
        summary:
          "Trate o sinal como evidência persistente e preserve o estado para investigação antes de qualquer recuperação autorizada.",
        steps: [
          "Confirme correlationId, total de tentativas e horário de entrada em estado DEAD.",
          "Compare o sinal com os metadados de dead-letter e com a saúde do runtime.",
          "Documente a recorrência e encaminhe a recuperação para o fluxo privilegiado apropriado, fora desta superfície.",
        ],
        evidenceToCollect: [
          "correlationId",
          "attempts",
          "occurredAt",
          "dead-letter metadata",
          "runtime health",
        ],
        escalation:
          "Escalone para o responsável pelo fluxo de recuperação; a Central permanece somente observacional neste runbook.",
      },
    },
  ],
};

const servers: ReturnType<typeof createAdminApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup() {
  const getIncidentCenter = vi.fn(async () => snapshot);
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
        capabilities: [{ key: "incident.read", riskTier: 0 as const }],
        scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        environment: "staging" as const,
      })),
    },
    readFacade: {
      searchPlayers: vi.fn(async () => ({ items: [], nextCursor: null })),
      getPlayer: vi.fn(),
      getIncidentCenter,
    },
    mutationFacade: { prepareMutation },
    rateLimiter: { consume },
  };
  const server = createAdminApiServer(dependencies);
  servers.push(server);
  return { server, getIncidentCenter, prepareMutation, consume };
}

describe("Admin API Incident Center read", () => {
  it("exposes a strict authenticated correlated-failure GET with its own rate-limit budget", async () => {
    const { server, getIncidentCenter, prepareMutation, consume } = setup();
    const response = await server.inject({
      method: "GET",
      url: "/admin/v1/incidents",
      headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(consume).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operation: "incident.read",
    });
    expect(getIncidentCenter).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: response.headers["x-correlation-id"],
    });
    expect(prepareMutation).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects browser-selected environment, limit, source or state", async () => {
    const { server, getIncidentCenter } = setup();
    for (const query of ["environment=production", "limit=100", "source=OUTBOX", "state=DEAD"]) {
      const response = await server.inject({
        method: "GET",
        url: `/admin/v1/incidents?${query}`,
        headers: { origin: ORIGIN, "cf-access-jwt-assertion": TOKEN },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(getIncidentCenter).not.toHaveBeenCalled();
  });
});
