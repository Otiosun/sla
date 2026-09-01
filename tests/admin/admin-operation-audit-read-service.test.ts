import { describe, expect, it, vi } from "vitest";
import { AdminOperationAuditReadService } from "../../src/modules/admin/admin-operation-audit-read-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const APPROVER_ID = "55555555-5555-4555-8555-555555555555";

const evidence = {
  operation: {
    id: OPERATION_ID,
    principalId: PRINCIPAL_ID,
    capabilityKey: "admin.role.assign",
    operationType: "admin.role.assign",
    targetType: "ADMIN_PRINCIPAL",
    targetId: TARGET_ID,
    riskTier: 4 as const,
    status: "APPLIED" as const,
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
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    updatedAt: new Date("2026-09-01T12:04:00.000Z"),
    appliedAt: new Date("2026-09-01T12:04:00.000Z"),
  },
  timeline: [
    {
      kind: "PROPOSED" as const,
      occurredAt: new Date("2026-09-01T12:00:00.000Z"),
      actorPrincipalId: PRINCIPAL_ID,
      action: "admin.role.assign.proposed",
      decision: null,
      resourceType: null,
      resourceId: null,
      eventId: OPERATION_ID,
    },
    {
      kind: "APPROVAL" as const,
      occurredAt: new Date("2026-09-01T12:03:00.000Z"),
      actorPrincipalId: APPROVER_ID,
      action: "admin.role.assign.approval",
      decision: "APPROVED" as const,
      resourceType: null,
      resourceId: null,
      eventId: "66666666-6666-4666-8666-666666666666",
    },
    {
      kind: "CHANGE" as const,
      occurredAt: new Date("2026-09-01T12:04:00.000Z"),
      actorPrincipalId: null,
      action: "admin.role.assign.change",
      decision: null,
      resourceType: "ADMIN_PRINCIPAL",
      resourceId: TARGET_ID,
      eventId: "77777777-7777-4777-8777-777777777777",
    },
    {
      kind: "AUDIT" as const,
      occurredAt: new Date("2026-09-01T12:04:00.000Z"),
      actorPrincipalId: PRINCIPAL_ID,
      action: "admin.role.assign",
      decision: null,
      resourceType: "ADMIN_PRINCIPAL",
      resourceId: TARGET_ID,
      eventId: "88888888-8888-4888-8888-888888888888",
    },
  ],
};

describe("AdminOperationAuditReadService", () => {
  it("authorizes a global admin-operation read and projects an allowlisted causal timeline", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "ADMIN_OPERATION", id: null }));
    const reconstruct = vi.fn(async () => evidence);
    const service = new AdminOperationAuditReadService({ authorizeRead }, { reconstruct });

    const result = await service.get({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
      operationId: OPERATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "admin.operation.audit.read",
      input: { operationId: OPERATION_ID },
      correlationId: CORRELATION_ID,
    });
    expect(reconstruct).toHaveBeenCalledWith(OPERATION_ID);
    expect(result).toMatchObject({
      operation: {
        id: OPERATION_ID,
        operationType: "admin.role.assign",
        correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        reasonRecorded: true,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:04:00.000Z",
        appliedAt: "2026-09-01T12:04:00.000Z",
      },
      timeline: [
        { kind: "PROPOSED", occurredAt: "2026-09-01T12:00:00.000Z" },
        {
          kind: "APPROVAL",
          decision: "APPROVED",
          occurredAt: "2026-09-01T12:03:00.000Z",
        },
        { kind: "CHANGE", occurredAt: "2026-09-01T12:04:00.000Z" },
        { kind: "AUDIT", occurredAt: "2026-09-01T12:04:00.000Z" },
      ],
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "input",
      "result",
      "before_data",
      "after_data",
      "metadata",
      "request_fingerprint",
      "idempotency_key",
      'reason":',
      "approvalReason",
      "sql",
      "payload",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
