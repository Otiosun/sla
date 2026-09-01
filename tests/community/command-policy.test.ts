import { describe, expect, it } from "vitest";
import type { CommunityChatContext } from "../../src/modules/community/contracts.js";
import {
  evaluateCommandPolicy,
  type CommandPolicyContext,
  type CommandPolicyRequirement,
} from "../../src/modules/community/command-policy.js";
import type { PlayerAccessRecord } from "../../src/modules/registration/player-access-ports.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const playerId = createPlayerId();

const reception: CommunityChatContext = {
  known: true,
  groupId: "11111111-1111-4111-8111-111111111111",
  role: "RECEPTION",
  capabilities: ["onboarding", "player.basic", "admin.review"],
};

const worldGroup: CommunityChatContext = {
  known: true,
  groupId: "22222222-2222-4222-8222-222222222222",
  role: "GAME",
  capabilities: ["player.basic", "world", "pve"],
};

const unknown: CommunityChatContext = {
  known: false,
  groupId: null,
  role: null,
  capabilities: [],
};

function access(status: PlayerAccessRecord["status"]): PlayerAccessRecord {
  return {
    playerId,
    status,
    approvedReviewId: status === "PENDING" ? null : "33333333-3333-4333-8333-333333333333",
    revision: 0,
  };
}

function context(input: Partial<CommandPolicyContext> = {}): CommandPolicyContext {
  return {
    group: reception,
    playerAccess: access("PENDING"),
    adminCapabilities: [],
    mechanicalReady: false,
    ...input,
  };
}

const registerPolicy: CommandPolicyRequirement = {
  requiredGroupCapabilities: ["onboarding"],
  allowedPlayerAccess: ["PENDING"],
};

const approvePolicy: CommandPolicyRequirement = {
  requiredGroupCapabilities: ["admin.review"],
  requiredAdminCapability: "player.registration.approve",
};

const travelPolicy: CommandPolicyRequirement = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
};

describe("community command policy", () => {
  it("allows registration only in onboarding-capable context before activation", () => {
    expect(evaluateCommandPolicy(context(), registerPolicy)).toEqual({ ok: true, value: undefined });

    expect(
      evaluateCommandPolicy(context({ playerAccess: access("ACTIVE") }), registerPolicy),
    ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });

    expect(
      evaluateCommandPolicy(context({ group: worldGroup }), registerPolicy),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });

  it("requires both the review-capable group and the administrative capability", () => {
    expect(
      evaluateCommandPolicy(
        context({ adminCapabilities: ["player.registration.approve"] }),
        approvePolicy,
      ),
    ).toEqual({ ok: true, value: undefined });

    expect(evaluateCommandPolicy(context(), approvePolicy)).toMatchObject({
      ok: false,
      error: { code: "PLAYER_INELIGIBLE" },
    });

    expect(
      evaluateCommandPolicy(
        context({ group: worldGroup, adminCapabilities: ["player.registration.approve"] }),
        approvePolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });

  it("denies world travel in Reception even for an active, mechanically ready player", () => {
    expect(
      evaluateCommandPolicy(
        context({ playerAccess: access("ACTIVE"), mechanicalReady: true }),
        travelPolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });

  it("allows world travel only when group, access and mechanical readiness all agree", () => {
    expect(
      evaluateCommandPolicy(
        context({ group: worldGroup, playerAccess: access("ACTIVE"), mechanicalReady: true }),
        travelPolicy,
      ),
    ).toEqual({ ok: true, value: undefined });

    expect(
      evaluateCommandPolicy(
        context({ group: worldGroup, playerAccess: access("PROVISIONING"), mechanicalReady: true }),
        travelPolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });

    expect(
      evaluateCommandPolicy(
        context({ group: worldGroup, playerAccess: access("ACTIVE"), mechanicalReady: false }),
        travelPolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("fails closed for unknown groups before any scoped command reaches a handler", () => {
    expect(
      evaluateCommandPolicy(
        context({
          group: unknown,
          playerAccess: access("ACTIVE"),
          adminCapabilities: ["player.registration.approve"],
          mechanicalReady: true,
        }),
        travelPolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });
});
