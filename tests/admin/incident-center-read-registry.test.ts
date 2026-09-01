import { describe, expect, it } from "vitest";
import { registerIncidentCenterRead } from "../../src/modules/admin/incident-center-definitions.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { ADMIN_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";

describe("incident center read registry", () => {
  it("registers a dedicated global read without privileged lifecycle", () => {
    const registry = new AdminOperationRegistry();
    registerIncidentCenterRead(registry);

    const definition = registry.require("incident.center.read");
    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("incident.read");
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

  it("declares incident.read as a canonical risk-tier-zero capability", () => {
    expect(ADMIN_CAPABILITIES).toContainEqual(["incident.read", 0]);
  });
});
