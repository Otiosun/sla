import { describe, expect, it, vi } from "vitest";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import type {
  AdminRoleAssignmentPort,
  AdminSessionRevocationPort,
} from "../../src/modules/admin/ports.js";

const TARGET_PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

function governancePort(): AdminRoleAssignmentPort & AdminSessionRevocationPort {
  return {
    simulateRoleAssignment: vi.fn(),
    applyRoleAssignment: vi.fn(),
    simulateSessionRevocation: vi.fn().mockResolvedValue({
      summary: {
        operation: "admin.session.revoke_all",
        environment: "staging",
        activeSessions: 2,
      },
      before: { environment: "staging", activeSessions: 2 },
      after: { environment: "staging", activeSessions: 0 },
    }),
    applySessionRevocation: vi.fn(),
  };
}

describe("admin.session.revoke_all policy", () => {
  it("registers a dedicated R4 semantic operation with independent approval gates", () => {
    const definition = createPhase12AdminOperationRegistry(governancePort()).require(
      "admin.session.revoke_all",
    );

    expect(definition).toMatchObject({
      kind: "MUTATION",
      capabilityKey: "admin.session.revoke",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: {
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: true,
        requiresConfirmation: true,
        requiredApprovals: 1,
      },
    });
    const input = definition.parseInput({
      principalId: TARGET_PRINCIPAL_ID,
      environment: "staging",
    });
    expect(input).toEqual({
      principalId: TARGET_PRINCIPAL_ID,
      environment: "staging",
    });
    expect(definition.target(input)).toEqual({
      type: "ADMIN_PRINCIPAL",
      id: TARGET_PRINCIPAL_ID,
    });
  });

  it("rejects session identifiers, fingerprints and other mass-assigned authority fields", () => {
    const definition = createPhase12AdminOperationRegistry(governancePort()).require(
      "admin.session.revoke_all",
    );

    expect(() =>
      definition.parseInput({
        principalId: TARGET_PRINCIPAL_ID,
        environment: "staging",
        tokenFingerprint: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      definition.parseInput({
        principalId: TARGET_PRINCIPAL_ID,
        environment: "staging",
        sessionId: "attacker-selected",
      }),
    ).toThrow();
  });
});
