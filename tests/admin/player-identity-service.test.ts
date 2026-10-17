import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { AdminPlayerIdentityService } from "../../src/modules/admin/player-identity-service.js";
import type { AdminPlayerIdentityChangeOwner } from "../../src/modules/admin/player-identity-ports.js";
import type { AdminService } from "../../src/modules/admin/service.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

function operation(input: Readonly<Record<string, unknown>>): AdminOperationRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    principalId,
    capabilityKey: "player.identity.change",
    operationType: "player.identity.whatsapp.change",
    targetType: "PLAYER",
    targetId: playerId,
    riskTier: 4,
    authorizationMode: "SUBJECT",
    status: "READY",
    reason: "Pedido confirmado pelo jogador",
    expectedRevision: 7n,
    idempotencyKey: `hub-player-identity:${requestId}`,
    requestFingerprint: "f".repeat(64),
    input,
    result: null,
    correlationId: requestId,
    policy: {
      version: 1,
      requiresReason: true,
      requiresExpectedRevision: true,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    },
    revision: 0n,
    appliedAt: null,
  };
}

describe("AdminPlayerIdentityService", () => {
  it("never persists the raw phone number in the admin operation input", async () => {
    let preparedInput: Readonly<Record<string, unknown>> | null = null;
    const admin = {
      prepareMutation: vi.fn(async (request: unknown) => {
        const parsed = request as { input: Readonly<Record<string, unknown>> };
        preparedInput = parsed.input;
        return { operation: operation(parsed.input), replayed: false };
      }),
    } as Pick<AdminService, "prepareMutation">;
    const owner: AdminPlayerIdentityChangeOwner = {
      changeWhatsAppIdentity: vi.fn(async ({ operation: prepared }) => ({
        ...prepared,
        status: "APPLIED",
        result: { changed: true, newIdentityLast4: "1234" },
      })),
    };
    const service = new AdminPlayerIdentityService(admin, owner);

    await service.changeWhatsApp({
      principalId,
      playerId,
      newWhatsApp: "+55 (79) 99999-1234",
      reason: "Pedido confirmado pelo jogador",
      expectedRevision: "7",
      requestId,
    });

    expect(preparedInput).toMatchObject({ playerId, newIdentityLast4: "1234" });
    expect(preparedInput).toHaveProperty("newIdentityDigest");
    expect(JSON.stringify(preparedInput)).not.toContain("5579999991234");
    expect(JSON.stringify(preparedInput)).not.toContain("99999-1234");
    expect(owner.changeWhatsAppIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "5579999991234@s.whatsapp.net" }),
    );
  });

  it("returns an already applied replay without touching the identity owner", async () => {
    const persisted = operation({
      playerId,
      newIdentityDigest: "a".repeat(64),
      newIdentityLast4: "1234",
    });
    const admin = {
      prepareMutation: vi.fn(async () => ({
        operation: { ...persisted, status: "APPLIED" as const },
        replayed: true,
      })),
    } as Pick<AdminService, "prepareMutation">;
    const owner: AdminPlayerIdentityChangeOwner = {
      changeWhatsAppIdentity: vi.fn(),
    };
    const service = new AdminPlayerIdentityService(admin, owner);

    const result = await service.changeWhatsApp({
      principalId,
      playerId,
      newWhatsApp: "+55 (79) 99999-1234",
      reason: "Pedido confirmado pelo jogador",
      expectedRevision: "7",
      requestId,
    });

    expect(result.replayed).toBe(true);
    expect(owner.changeWhatsAppIdentity).not.toHaveBeenCalled();
  });
});
