import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExternalAdminMutationEndpoint, type AdminMutationOwner } from "../../src/modules/anti-abuse/external-admin-endpoint.js";
import { ExternalCaptureMutationEndpoint, type CaptureMutationOwner } from "../../src/modules/anti-abuse/external-capture-endpoint.js";
import { ExternalEconomyMutationEndpoint, type EconomyPurchaseOwner } from "../../src/modules/anti-abuse/external-economy-endpoint.js";
import { ProtectedBattleGateway, type BattleActionOwner } from "../../src/modules/anti-abuse/protected-battle-gateway.js";
import type { MutationAdmissionPort, MutationRatePolicy } from "../../src/modules/anti-abuse/contracts.js";
import type { AdminOperationRecord, AdminPreparedOperation } from "../../src/modules/admin/contracts.js";
import type { CaptureAttemptInput } from "../../src/modules/capture/contracts.js";
import type { PurchaseInput } from "../../src/modules/economy/service.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";
import { parseCorrelationId, parseEncounterId, parsePlayerId } from "../../src/shared-kernel/ids.js";

const proofPolicy: MutationRatePolicy = { policyKey: "test.block.v1", maxEvents: 1, windowMs: 60_000 };
const blockedAdmission: MutationAdmissionPort = {
  async consume() {
    return ok({ allowed: false, replayed: false, retryAfterMs: 1234 });
  },
};

function required<T>(value: { ok: true; value: T } | { ok: false }): T {
  if (!value.ok) throw new Error("Invalid test fixture ID");
  return value.value;
}

function adminOperation(principalId: string): AdminOperationRecord {
  return {
    id: randomUUID(), principalId, capabilityKey: "inventory.adjust", operationType: "inventory.adjust",
    targetType: "PLAYER", targetId: randomUUID(), riskTier: 2, authorizationMode: "SUBJECT",
    status: "READY", reason: "test", expectedRevision: null, idempotencyKey: "test-admin-idem",
    requestFingerprint: "a".repeat(64), input: {}, result: null, correlationId: randomUUID(),
    policy: { version: 1, requiresReason: false, requiresExpectedRevision: false, requiresSimulation: false, requiresConfirmation: false, requiredApprovals: 0 },
    revision: 0n, appliedAt: null,
  };
}

describe("external mutation anti-abuse boundaries", () => {
  it("blocks Capture before the owner", async () => {
    const playerId = required(parsePlayerId(randomUUID()));
    let calls = 0;
    const owner: CaptureMutationOwner = {
      async attempt() { calls += 1; return err(appError("ACTION_INVALID", "stub")); },
    };
    const endpoint = new ExternalCaptureMutationEndpoint(owner, blockedAdmission, proofPolicy);
    const input: CaptureAttemptInput = {
      playerId,
      encounterId: required(parseEncounterId(randomUUID())),
      expectedEncounterRevision: 0n,
      expectedBattleVersion: null,
      ballItemId: randomUUID(),
      idempotencyKey: "capture-test",
      correlationId: required(parseCorrelationId(randomUUID())),
      causationId: null,
    };
    const result = await endpoint.attempt(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RATE_LIMITED");
    expect(calls).toBe(0);
  });

  it("blocks Battle before the owner", async () => {
    let calls = 0;
    const owner: BattleActionOwner = {
      async resolvePlayerTurn() {
        calls += 1;
        return { ok: false, error: { code: "BATTLE_NOT_FOUND", message: "stub" } };
      },
    };
    const endpoint = new ProtectedBattleGateway(owner, blockedAdmission, proofPolicy);
    const result = await endpoint.resolvePlayerTurn({
      battleId: randomUUID(), playerId: randomUUID(), expectedVersion: 0,
      idempotencyKey: "battle-test",
      action: { type: "FLEE", actorParticipantId: randomUUID() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BATTLE_RATE_LIMITED");
    expect(calls).toBe(0);
  });

  it("restricts external Economy to self-player purchase and blocks before owner", async () => {
    const playerId = required(parsePlayerId(randomUUID()));
    const correlationId = required(parseCorrelationId(randomUUID()));
    let calls = 0;
    const owner: EconomyPurchaseOwner = {
      async purchase() { calls += 1; return err(appError("ACTION_INVALID", "stub")); },
    };
    const endpoint = new ExternalEconomyMutationEndpoint(owner, blockedAdmission, proofPolicy);
    const valid: PurchaseInput = {
      playerId, offerKey: "proof.offer", idempotencyKey: "economy-test",
      metadata: { sourceType: "TEST", sourceId: "boundary", reason: "proof", actorType: "PLAYER", actorId: playerId, correlationId },
    };
    const blocked = await endpoint.purchase(valid);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("RATE_LIMITED");
    const system = await endpoint.purchase({
      ...valid,
      metadata: { ...valid.metadata, actorType: "SYSTEM", actorId: null },
    });
    expect(system.ok).toBe(false);
    if (!system.ok) expect(system.error.code).toBe("PLAYER_INELIGIBLE");
    expect(calls).toBe(0);
  });

  it("blocks Admin mutation before AdminService owner", async () => {
    const principalId = randomUUID();
    let calls = 0;
    const owner: AdminMutationOwner = {
      async prepareMutation(): Promise<AdminPreparedOperation> {
        calls += 1;
        return { operation: adminOperation(principalId), replayed: false };
      },
      async simulate() { return adminOperation(principalId); },
      async confirm() { return adminOperation(principalId); },
      async approve() { return adminOperation(principalId); },
      async apply() { return adminOperation(principalId); },
    };
    const endpoint = new ExternalAdminMutationEndpoint(owner, blockedAdmission, proofPolicy);
    await expect(endpoint.prepareMutation({
      principalId,
      operationType: "inventory.adjust",
      input: { playerId: randomUUID(), delta: 1 },
      reason: "proof",
      idempotencyKey: "admin-test-0001",
      correlationId: randomUUID(),
    })).rejects.toMatchObject({ code: "ADMIN_RATE_LIMITED" });
    expect(calls).toBe(0);
  });
});
