import { describe, expect, it } from "vitest";
import { registerMessagingOperationsRead } from "../../src/modules/admin/messaging-operations-definitions.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { ADMIN_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";

describe("messaging operations read registry", () => {
  it("registers a dedicated read-only operational view without privileged lifecycle", () => {
    const registry = new AdminOperationRegistry();
    registerMessagingOperationsRead(registry);

    const definition = registry.require("messaging.operations.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("messaging.operations.read");
    expect(definition.riskTier).toBe(0);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.policy).toEqual({
      version: 1,
      requiresReason: false,
      requiresExpectedRevision: false,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    });
    expect(definition.parseInput({})).toEqual({});
  });

  it("declares the dedicated capability as canonical risk tier zero", () => {
    expect(ADMIN_CAPABILITIES).toContainEqual(["messaging.operations.read", 0]);
  });
});
