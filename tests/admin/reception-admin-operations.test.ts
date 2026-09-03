import { describe, expect, it } from "vitest";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerReceptionAdminOperations } from "../../src/modules/admin/reception-operation-definitions.js";

const EXPECTED = [
  ["registration.review.read", "player.registration.read", "READ", 0],
  ["registration.review.request_changes", "player.registration.request_changes", "MUTATION", 1],
  ["registration.review.approve", "player.registration.approve", "MUTATION", 2],
  ["registration.review.reject", "player.registration.reject", "MUTATION", 2],
  ["registration.review.reopen", "player.registration.reopen", "MUTATION", 2],
  ["player.access.suspend", "player.access.suspend", "MUTATION", 3],
  ["player.access.restore", "player.access.restore", "MUTATION", 2],
  ["community.group.manage", "community.group.manage", "MUTATION", 3],
  ["community.reception.staff.manage", "community.reception.staff.manage", "MUTATION", 2],
] as const;

describe("reception/admin operation definitions", () => {
  it("registers the complete operation surface with granular capabilities", () => {
    const registry = registerReceptionAdminOperations(new AdminOperationRegistry());

    for (const [operationType, capabilityKey, kind, riskTier] of EXPECTED) {
      const definition = registry.require(operationType);
      expect(definition.capabilityKey).toBe(capabilityKey);
      expect(definition.kind).toBe(kind);
      expect(definition.riskTier).toBe(riskTier);
    }
  });

  it("records source channel in strict inputs and rejects unknown channels", () => {
    const registry = registerReceptionAdminOperations(new AdminOperationRegistry());
    const definition = registry.require("registration.review.approve");
    const input = {
      reviewId: "33333333-3333-4333-8333-333333333333",
      playerId: "44444444-4444-4444-8444-444444444444",
      sourceChannel: "WHATSAPP",
    } as const;

    expect(definition.parseInput(input)).toEqual(input);
    expect(() => definition.parseInput({ ...input, sourceChannel: "WHATSAPP_ADMIN" })).toThrow();
    expect(() => definition.parseInput({ ...input, role: "MASTER_ADMIN" })).toThrow();
  });

  it("requires optimistic revision for review/access/group mutations but not manual comments", () => {
    const registry = registerReceptionAdminOperations(new AdminOperationRegistry());

    for (const operationType of [
      "registration.review.request_changes",
      "registration.review.approve",
      "registration.review.reject",
      "registration.review.reopen",
      "player.access.suspend",
      "player.access.restore",
      "community.group.manage",
    ]) {
      const definition = registry.require(operationType);
      expect(definition.policy.requiresExpectedRevision).toBe(true);
    }

    expect(registry.require("registration.review.request_changes").policy.requiresReason).toBe(false);
    expect(registry.require("registration.review.approve").policy.requiresReason).toBe(false);
    expect(registry.require("registration.review.reject").policy.requiresReason).toBe(false);
  });
});
