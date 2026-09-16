import { describe, expect, it } from "vitest";
import { CommunityGroupAdminService } from "../../src/modules/admin/community-group-service.js";
import { ok } from "../../src/shared-kernel/result.js";

describe("CommunityGroupAdminService", () => {
  it("applies REPLACE_CAPABILITIES and completes the admin operation", async () => {
    const domainCalls: unknown[] = [];
    const completions: unknown[] = [];

    const appliedOperation = { status: "APPLIED" } as never;

    const service = new CommunityGroupAdminService({
      community: {
        getGroupConfiguration: async () => ({
          id: "22222222-2222-4222-8222-222222222222",
          provider: "baileys",
          chatRef: "120363429277815192@g.us",
          role: "GAME",
          displayName: "UAT Zhoulia",
          status: "ACTIVE",
          revision: 1,
          capabilities: ["player.basic", "world"],
        }),
        renameGroup: async () => {
          throw new Error("unexpected rename");
        },
        retireGroup: async () => {
          throw new Error("unexpected retire");
        },
        replaceCapabilities: async (input) => {
          domainCalls.push(input);

          return ok({
            id: "22222222-2222-4222-8222-222222222222",
            provider: "baileys",
            chatRef: "120363429277815192@g.us",
            role: "GAME",
            displayName: "UAT Zhoulia",
            status: "ACTIVE",
            revision: 2,
          });
        },
      },
      completion: {
        completeAppliedOperation: async (input) => {
          completions.push(input);
          return appliedOperation;
        },
      },
    });

    const operation = {
      expectedRevision: 1n,
    } as never;

    const result = await service.applyCommunityGroupManage(
      operation,
      "11111111-1111-4111-8111-111111111111",
      {
        groupId: "22222222-2222-4222-8222-222222222222",
        sourceChannel: "WHATSAPP",
        action: "REPLACE_CAPABILITIES",
        payload: {
          capabilities: ["world", "pve", "player.basic"],
        },
      },
    );

    expect(result).toBe(appliedOperation);

    expect(domainCalls).toEqual([
      {
        groupId: "22222222-2222-4222-8222-222222222222",
        expectedRevision: 1,
        capabilities: ["player.basic", "pve", "world"],
      },
    ]);

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      beforeData: {
        id: "22222222-2222-4222-8222-222222222222",
        role: "GAME",
        displayName: "UAT Zhoulia",
        status: "ACTIVE",
        revision: 1,
        capabilities: ["player.basic", "world"],
      },
      afterData: {
        id: "22222222-2222-4222-8222-222222222222",
        role: "GAME",
        displayName: "UAT Zhoulia",
        status: "ACTIVE",
        revision: 2,
        capabilities: ["player.basic", "pve", "world"],
      },
      actorPrincipalId: "11111111-1111-4111-8111-111111111111",
      resourceType: "COMMUNITY_GROUP",
      resourceId: "22222222-2222-4222-8222-222222222222",
      result: {
        groupId: "22222222-2222-4222-8222-222222222222",
        action: "REPLACE_CAPABILITIES",
      },
      auditTarget: {
        type: "COMMUNITY_GROUP",
        id: "22222222-2222-4222-8222-222222222222",
      },
      auditMetadata: {
        sourceChannel: "WHATSAPP",
      },
    });
  });
});
