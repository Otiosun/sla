import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerPlayerIdentityAdminOperations } from "../../src/modules/admin/player-identity-definitions.js";
import type {
  AdminOperationRepository,
  CreateAdminOperationInput,
} from "../../src/modules/admin/ports.js";
import { AdminService } from "../../src/modules/admin/service.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";

function operationFrom(input: CreateAdminOperationInput): AdminOperationRecord {
  return {
    id: input.id,
    principalId: input.principalId,
    capabilityKey: input.capabilityKey,
    operationType: input.operationType,
    targetType: input.target.type,
    targetId: input.target.id,
    riskTier: input.riskTier,
    authorizationMode: input.authorizationMode,
    status: input.status,
    reason: input.reason,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    input: input.input,
    result: null,
    correlationId: input.correlationId,
    policy: {
      version: input.policyVersion,
      requiresReason: input.requiresReason,
      requiresExpectedRevision: input.requiresExpectedRevision,
      requiresSimulation: input.requiresSimulation,
      requiresConfirmation: input.requiresConfirmation,
      requiredApprovals: input.requiredApprovals,
    },
    revision: 0n,
    appliedAt: null,
  };
}

function harness() {
  let stored: AdminOperationRecord | null = null;
  const repository: AdminOperationRepository = {
    getAuthorizationSnapshot: vi.fn(async () => ({
      principalId,
      status: "ACTIVE" as const,
      capabilities: [{ key: "player.identity.change", riskTier: 4 as const }],
      scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
    })),
    createOrReplayOperation: vi.fn(async (input) => {
      stored = operationFrom(input);
      return { operation: stored, replayed: false };
    }),
    getOperation: vi.fn(async () => stored),
    saveSimulation: vi.fn(async () => {
      throw new Error("not used");
    }),
    recordConfirmation: vi.fn(async () => {
      throw new Error("not used");
    }),
    recordApproval: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  const registry = registerPlayerIdentityAdminOperations(new AdminOperationRegistry());
  return { repository, service: new AdminService(registry, repository) };
}

const request = {
  principalId,
  operationType: "player.identity.whatsapp.change",
  input: {
    playerId,
    newIdentityDigest: "a".repeat(64),
    newIdentityLast4: "1234",
  },
  reason: "Pedido confirmado pelo jogador",
  expectedRevision: "7",
  idempotencyKey: "identity-change-request-0001",
  correlationId,
};

describe("ephemeral-sensitive admin operations", () => {
  it("does not expose the identity change through the generic operation catalog", () => {
    const { service } = harness();
    expect(service.listOperationDefinitions()).toEqual([]);
  });

  it("rejects generic preparation but allows the dedicated sensitive preparation path", async () => {
    const { repository, service } = harness();

    await expect(service.prepareMutation(request)).rejects.toMatchObject({
      code: "ADMIN_OPERATION_KIND_MISMATCH",
    });
    expect(repository.createOrReplayOperation).not.toHaveBeenCalled();

    const prepared = await service.prepareEphemeralSensitiveMutation(request);
    expect(prepared.operation.status).toBe("READY");
    expect(prepared.operation.capabilityKey).toBe("player.identity.change");
    expect(repository.createOrReplayOperation).toHaveBeenCalledTimes(1);
  });

  it("rejects the generic apply surface for a prepared sensitive operation", async () => {
    const { service } = harness();
    const prepared = await service.prepareEphemeralSensitiveMutation(request);

    await expect(service.apply(prepared.operation.id, principalId)).rejects.toMatchObject({
      code: "ADMIN_INVALID_OPERATION_STATE",
    });
  });
});
