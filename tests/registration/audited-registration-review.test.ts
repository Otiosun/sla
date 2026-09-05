import { describe, expect, it } from "vitest";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { AuditedRegistrationReviewService } from "../../src/modules/registration/admin-review-service.js";
import type { RegistrationRevisionRecord } from "../../src/modules/registration/ports.js";
import { ok } from "../../src/shared-kernel/result.js";

const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
const PLAYER_ID = "44444444-4444-4444-8444-444444444444" as never;
const ADMIN_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const CORRELATION_ID = "77777777-7777-4777-8777-777777777777";

function review(revision = 4, status: RegistrationRevisionRecord["status"] = "SUBMITTED") {
  return {
    id: REVIEW_ID,
    playerId: PLAYER_ID,
    sequenceNo: 2,
    status,
    snapshot: {
      trainerName: "Liora Vale",
      age: 17,
      genderPronouns: "ela/dela",
      appearance: "Cabelos negros e casaco de viagem.",
      personality: "Curiosa e competitiva.",
      backstory: "Saiu de casa para pesquisar Pokémon raros.",
      starterFormId: "22222222-2222-4222-8222-222222222222",
      regionId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 1,
    },
    revision,
  } satisfies RegistrationRevisionRecord;
}

function operation(status: AdminOperationRecord["status"] = "READY"): AdminOperationRecord {
  return {
    id: OPERATION_ID,
    principalId: ADMIN_ID,
    capabilityKey: "player.registration.approve",
    operationType: "registration.review.approve",
    targetType: "PLAYER",
    targetId: PLAYER_ID,
    riskTier: 2,
    authorizationMode: "SUBJECT",
    status,
    reason: null,
    expectedRevision: 4n,
    idempotencyKey: "inbox:baileys:approve:admin-review",
    requestFingerprint: "fingerprint",
    input: {
      reviewId: REVIEW_ID,
      playerId: PLAYER_ID,
      sourceChannel: "WHATSAPP",
    },
    result: status === "APPLIED" ? { reviewId: REVIEW_ID, status: "APPROVED" } : null,
    correlationId: CORRELATION_ID,
    policy: {
      version: 1,
      requiresReason: false,
      requiresExpectedRevision: true,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    },
    revision: status === "APPLIED" ? 2n : 1n,
    appliedAt: status === "APPLIED" ? new Date("2026-09-03T12:00:00.000Z") : null,
  };
}

function harness(replayed = false) {
  const before = review();
  const after = { ...before, status: "APPROVED" as const, revision: 5, replayed: false };
  const prepared: unknown[] = [];
  const authorizedReads: unknown[] = [];
  const domainCalls: unknown[] = [];
  const completions: unknown[] = [];

  const service = new AuditedRegistrationReviewService({
    admin: {
      authorizeRead: async (input: unknown) => {
        authorizedReads.push(input);
        return { type: "PLAYER", id: PLAYER_ID };
      },
      prepareMutation: async (input: unknown) => {
        prepared.push(input);
        return { operation: operation(replayed ? "APPLIED" : "READY"), replayed };
      },
    },
    registration: {
      getReview: async () => ok(replayed ? after : before),
      requestChanges: async (input: unknown) => {
        domainCalls.push({ kind: "REQUEST_CHANGES", input });
        return ok({ ...after, status: "CHANGES_REQUESTED" as const });
      },
      approve: async (input: unknown) => {
        domainCalls.push({ kind: "APPROVE", input });
        return ok(after);
      },
      reject: async (input: unknown) => {
        domainCalls.push({ kind: "REJECT", input });
        return ok({ ...after, status: "REJECTED" as const });
      },
    },
    completion: {
      completeAppliedOperation: async (input: unknown) => {
        completions.push(input);
        return operation("APPLIED");
      },
    },
  });

  return { service, prepared, authorizedReads, domainCalls, completions };
}

describe("audited registration review service", () => {
  it("authorizes reads through the admin registry and keeps the source channel", async () => {
    const h = harness();
    const result = await h.service.getReview({
      principalId: ADMIN_ID,
      reviewId: REVIEW_ID,
      sourceChannel: "CONTROL_CENTER",
    });

    expect(result).toMatchObject({ ok: true, value: { id: REVIEW_ID } });
    expect(h.authorizedReads).toEqual([
      {
        principalId: ADMIN_ID,
        operationType: "registration.review.read",
        input: {
          reviewId: REVIEW_ID,
          playerId: PLAYER_ID,
          sourceChannel: "CONTROL_CENTER",
        },
      },
    ]);
  });

  it("prepares approval before the domain mutation and completes an auditable review target", async () => {
    const h = harness();
    const result = await h.service.approve({
      principalId: ADMIN_ID,
      reviewId: REVIEW_ID,
      expectedRevision: 4,
      idempotencyKey: "inbox:baileys:approve:admin-review",
      correlationId: CORRELATION_ID,
      sourceChannel: "WHATSAPP",
    });

    expect(result).toMatchObject({ ok: true, value: { status: "APPROVED", revision: 5 } });
    expect(h.prepared).toEqual([
      {
        principalId: ADMIN_ID,
        operationType: "registration.review.approve",
        input: {
          reviewId: REVIEW_ID,
          playerId: PLAYER_ID,
          sourceChannel: "WHATSAPP",
        },
        expectedRevision: 4n,
        idempotencyKey: "inbox:baileys:approve:admin-review",
        correlationId: CORRELATION_ID,
      },
    ]);
    expect(h.domainCalls).toEqual([
      {
        kind: "APPROVE",
        input: {
          reviewId: REVIEW_ID,
          expectedRevision: 4,
          actor: { adminPrincipalId: ADMIN_ID },
          idempotencyKey: `admin-operation:${OPERATION_ID}`,
        },
      },
    ]);
    expect(h.completions).toEqual([
      expect.objectContaining({
        actorPrincipalId: ADMIN_ID,
        resourceType: "REGISTRATION_REVIEW",
        resourceId: REVIEW_ID,
        auditTarget: { type: "REGISTRATION_REVIEW", id: REVIEW_ID },
        auditMetadata: { sourceChannel: "WHATSAPP" },
      }),
    ]);
  });

  it("replays an already applied admin operation without deciding the ficha twice", async () => {
    const h = harness(true);
    const result = await h.service.approve({
      principalId: ADMIN_ID,
      reviewId: REVIEW_ID,
      expectedRevision: 4,
      idempotencyKey: "inbox:baileys:approve:admin-review",
      correlationId: CORRELATION_ID,
      sourceChannel: "WHATSAPP",
    });

    expect(result).toMatchObject({ ok: true, value: { status: "APPROVED" } });
    expect(h.domainCalls).toEqual([]);
    expect(h.completions).toEqual([]);
  });
});
