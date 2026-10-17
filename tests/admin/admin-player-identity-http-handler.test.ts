import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { AdminPlayerIdentityHttpHandler } from "../../src/modules/player-portal/admin-player-identity-http-handler.js";
import { HubSessionTokenService } from "../../src/modules/player-portal/session-token-service.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const identity = { provider: "baileys", externalId: "5579999990001@s.whatsapp.net" } as const;

function operation(): AdminOperationRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    principalId,
    capabilityKey: "player.identity.change",
    operationType: "player.identity.whatsapp.change",
    targetType: "PLAYER",
    targetId: playerId,
    riskTier: 4,
    authorizationMode: "SUBJECT",
    status: "APPLIED",
    reason: "Pedido confirmado pelo jogador",
    expectedRevision: 7n,
    idempotencyKey: `hub-player-identity:${requestId}`,
    requestFingerprint: "a".repeat(64),
    input: {
      playerId,
      newIdentityDigest: "b".repeat(64),
      newIdentityLast4: "1234",
    },
    result: {
      changed: true,
      playerRevision: "8",
      newIdentityLast4: "1234",
    },
    correlationId: requestId,
    policy: {
      version: 1,
      requiresReason: true,
      requiresExpectedRevision: true,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    },
    revision: 1n,
    appliedAt: new Date("2026-10-16T12:00:00.000Z"),
  };
}

function harness(owner = true) {
  const sessions = new HubSessionTokenService({
    signingKey: new Uint8Array(32).fill(7),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
  });
  const issued = sessions.issue(identity);
  if (!issued.ok) throw new Error("test session issuance failed");

  const admin = {
    resolvePrincipal: vi.fn(async () => ({ principalId })),
    capabilitiesFor: vi.fn(async () => ["central.view", "player.identity.change"]),
  };
  const adminTeam = {
    isOwner: vi.fn(async () => owner),
  };
  const changeWhatsApp = vi.fn(async () => ({ operation: operation(), replayed: false }));
  const handler = new AdminPlayerIdentityHttpHandler({
    sessions,
    admin,
    adminTeam,
    identity: { changeWhatsApp },
  });

  return { handler, token: issued.value.token, changeWhatsApp, adminTeam };
}

function changeRequest(token: string, body: Readonly<Record<string, unknown>>) {
  return new Request(`https://hub.example/v1/hub/admin/players/${playerId}/whatsapp-identity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `__Host-pokemon_hub_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  requestId,
  newWhatsApp: "+55 (79) 99999-1234",
  reason: "Pedido confirmado pelo jogador",
  expectedRevision: "7",
  confirmed: true,
} as const;

describe("AdminPlayerIdentityHttpHandler", () => {
  it("ignores unrelated routes", async () => {
    const { handler } = harness();
    await expect(
      handler.handle(new Request("https://hub.example/v1/hub/player/self")),
    ).resolves.toBe(null);
  });

  it("requires an authenticated session and the protected owner role", async () => {
    const { handler, token, changeWhatsApp } = harness(false);
    const response = await handler.handle(changeRequest(token, validBody));
    expect(response?.status).toBe(403);
    expect(changeWhatsApp).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before the sensitive mutation", async () => {
    const { handler, token, changeWhatsApp } = harness();
    const response = await handler.handle(changeRequest(token, { ...validBody, confirmed: false }));
    expect(response?.status).toBe(400);
    expect(changeWhatsApp).not.toHaveBeenCalled();
  });

  it("executes the owner-only change without echoing the raw phone number", async () => {
    const { handler, token, changeWhatsApp } = harness();
    const response = await handler.handle(changeRequest(token, validBody));
    expect(response?.status).toBe(200);
    expect(changeWhatsApp).toHaveBeenCalledWith({
      principalId,
      playerId,
      newWhatsApp: validBody.newWhatsApp,
      reason: validBody.reason,
      expectedRevision: validBody.expectedRevision,
      requestId,
    });

    const text = await response?.text();
    expect(text).toContain("1234");
    expect(text).not.toContain("5579999991234");
    expect(text).not.toContain("99999-1234");
  });
});
