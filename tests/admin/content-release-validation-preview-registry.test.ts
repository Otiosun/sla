import { describe, expect, it, vi } from "vitest";
import {
  registerPhase12CCatalogReleaseOperations,
} from "../../src/modules/admin/catalog-release-definitions.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";

describe("content release validation preview registry", () => {
  it("registers validation preview as a READ operation using content.validate authority", () => {
    const registry = new AdminOperationRegistry();
    registerPhase12CCatalogReleaseOperations(registry, {
      diff: vi.fn(),
      simulateCatalogReleasePublish: vi.fn(),
      applyCatalogReleaseValidate: vi.fn(),
      applyCatalogReleasePublish: vi.fn(),
    });

    const definition = registry.require("content.release.validation_preview");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("content.validate");
    expect(definition.riskTier).toBe(3);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.policy).toEqual({
      version: 1,
      requiresReason: false,
      requiresExpectedRevision: false,
      requiresSimulation: false,
      requiresConfirmation: false,
      requiredApprovals: 0,
    });
    expect(
      definition.parseInput({
        releaseId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual({ releaseId: "22222222-2222-4222-8222-222222222222" });
  });
});
