import { describe, expect, it } from "vitest";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";
import type { AdminRoleAssignmentPort } from "../../src/modules/admin/ports.js";

const unusedRoleAssignmentPort: AdminRoleAssignmentPort = {
  async simulateRoleAssignment() {
    throw new Error("not used in catalog policy tests");
  },
  async applyRoleAssignment() {
    throw new Error("not used in catalog policy tests");
  },
};

describe("admin catalog read policy alignment", () => {
  it("keeps every catalog read risk tier aligned with its canonical capability", () => {
    const registry = createPhase12AdminOperationRegistry(unusedRoleAssignmentPort);
    const riskByCapability = new Map<string, number>(
      ADMIN_CAPABILITIES.map(([key, riskTier]) => [key, riskTier]),
    );
    const catalogReads = registry
      .list()
      .filter((definition) => definition.kind === "READ" && definition.operationType.endsWith(".catalog.read"));

    expect(catalogReads.length).toBeGreaterThan(0);
    for (const definition of catalogReads) {
      expect(riskByCapability.has(definition.capabilityKey)).toBe(true);
      expect(definition.riskTier).toBe(riskByCapability.get(definition.capabilityKey));
    }
  });

  it("preserves the intended authorization boundary for Pokemon and release catalogs", () => {
    const definitions = createPhase12AdminOperationRegistry(unusedRoleAssignmentPort).list();
    const byType = new Map(definitions.map((definition) => [definition.operationType, definition]));

    expect(byType.get("pokemon.form_catalog.read")).toMatchObject({
      capabilityKey: "pokemon.create",
      riskTier: 3,
    });
    expect(byType.get("pokemon.effect_catalog.read")).toMatchObject({
      capabilityKey: "pokemon.edit.mechanics",
      riskTier: 3,
    });
    expect(byType.get("content.release.catalog.read")).toMatchObject({
      capabilityKey: "central.view",
      riskTier: 0,
    });
  });
});
