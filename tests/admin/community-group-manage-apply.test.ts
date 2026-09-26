import { describe, expect, it } from "vitest";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerReceptionAdminOperations } from "../../src/modules/admin/reception-operation-definitions.js";

describe("community.group.manage apply wiring", () => {
  it("delegates REPLACE_CAPABILITIES to the community-group mutation owner", async () => {
    const calls: unknown[][] = [];

    const register = registerReceptionAdminOperations as unknown as (
      registry: AdminOperationRegistry,
      dependencies: {
        readonly communityGroup: {
          applyCommunityGroupManage(...args: unknown[]): Promise<unknown>;
        };
      },
    ) => AdminOperationRegistry;

    const registry = register(new AdminOperationRegistry(), {
      communityGroup: {
        applyCommunityGroupManage: async (...args: unknown[]) => {
          calls.push(args);
          return {} as never;
        },
      },
    });

    const definition = registry.require("community.group.manage");

    expect(definition.apply).toBeTypeOf("function");
    const apply = definition.apply;
    if (apply === undefined) throw new Error("community.group.manage apply handler missing");

    await apply(
      {
        operation: {} as never,
        actorPrincipalId: "11111111-1111-4111-8111-111111111111",
      },
      {
        groupId: "22222222-2222-4222-8222-222222222222",
        sourceChannel: "WHATSAPP",
        action: "REPLACE_CAPABILITIES",
        payload: {
          capabilities: ["player.basic", "world", "pve"],
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({
      action: "REPLACE_CAPABILITIES",
      payload: {
        capabilities: ["player.basic", "world", "pve"],
      },
    });
  });
});
