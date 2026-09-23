import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const wiring = vi.hoisted(() => ({
  ownerConstructed: vi.fn(),
  registrationDependencies: vi.fn(),
}));

vi.mock("../../src/modules/admin/community-group-service.js", () => ({
  CommunityGroupAdminService: class {
    public constructor(dependencies: unknown) {
      wiring.ownerConstructed(dependencies);
    }

    public async applyCommunityGroupManage(): Promise<never> {
      throw new Error("not exercised by composition test");
    }
  },
}));

vi.mock("../../src/modules/admin/reception-operation-definitions.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/modules/admin/reception-operation-definitions.js")
    >();

  return {
    ...actual,
    registerReceptionAdminOperations: (
      registry: Parameters<typeof actual.registerReceptionAdminOperations>[0],
      dependencies?: Parameters<typeof actual.registerReceptionAdminOperations>[1],
    ) => {
      wiring.registrationDependencies(dependencies);
      return actual.registerReceptionAdminOperations(registry, dependencies);
    },
  };
});

import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("community admin runtime composition", () => {
  it("wires CommunityGroupAdminService into community.group.manage", () => {
    createOperationalMessagingComposition({} as Pool);

    expect(wiring.ownerConstructed).toHaveBeenCalledOnce();

    const owner = wiring.registrationDependencies.mock.calls[0]?.[0]?.communityGroup;

    expect(owner).toBeDefined();
  });
});
