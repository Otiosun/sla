import { describe, expect, it } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();

function context(input: {
  readonly chatRef?: string;
  readonly senderRef?: string;
} = {}): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000701",
    correlationId: "00000000-0000-4000-8000-000000000702",
    causationId: "00000000-0000-4000-8000-000000000701",
    idempotencyKey: "policy-gate-test",
    message: {
      provider: "baileys",
      externalMessageId: "policy-gate-message",
      senderRef: input.senderRef ?? "5511999999999@s.whatsapp.net",
      chatRef: input.chatRef ?? "reception@g.us",
      occurredAt: "2026-09-02T04:30:00.000Z",
      text: "$registrar",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function dependencies(input: {
  readonly player?: "MISSING" | "PENDING" | "ACTIVE_COMPLETE" | "ACTIVE_INCOMPLETE";
  readonly group?: "RECEPTION" | "WORLD" | "UNKNOWN";
  readonly adminCapabilities?: readonly string[];
} = {}) {
  const player = input.player ?? "PENDING";
  const group = input.group ?? "RECEPTION";
  return {
    community: {
      resolveChat: async () => {
        if (group === "UNKNOWN") {
          return { known: false, groupId: null, role: null, capabilities: [] } as const;
        }
        return group === "RECEPTION"
          ? {
              known: true,
              groupId: "00000000-0000-4000-8000-000000000711",
              role: "RECEPTION" as const,
              capabilities: ["onboarding" as const, "player.basic" as const],
            }
          : {
              known: true,
              groupId: "00000000-0000-4000-8000-000000000712",
              role: "GAME" as const,
              capabilities: ["world" as const, "player.basic" as const],
            };
      },
    },
    players: {
      resolvePlayer: async () =>
        player === "MISSING"
          ? err(appError("NOT_FOUND", "Player not found"))
          : ok({
              playerId: PLAYER_ID,
              state:
                player === "ACTIVE_COMPLETE"
                  ? "COMPLETE"
                  : player === "ACTIVE_INCOMPLETE"
                    ? "STARTER_GRANTED"
                    : "NEW",
            }),
    },
    access: {
      load: async () => ({
        playerId: PLAYER_ID,
        status: player === "ACTIVE_COMPLETE" || player === "ACTIVE_INCOMPLETE" ? "ACTIVE" : "PENDING",
        approvedReviewId:
          player === "ACTIVE_COMPLETE" || player === "ACTIVE_INCOMPLETE"
            ? "00000000-0000-4000-8000-000000000713"
            : null,
        revision: player === "ACTIVE_COMPLETE" || player === "ACTIVE_INCOMPLETE" ? 2 : 0,
      } as const),
    },
    admins: {
      capabilitiesFor: async () => input.adminCapabilities ?? [],
    },
  };
}

describe("RuntimeCommandPolicyGate", () => {
  it("treats an unbound identity as pending only for a policy that explicitly allows pending", async () => {
    const gate = new RuntimeCommandPolicyGate(dependencies({ player: "MISSING" }));

    expect(
      await gate.authorize(context(), {
        requiredGroupCapabilities: ["onboarding"],
        allowedPlayerAccess: ["PENDING"],
      }),
    ).toEqual(ok(undefined));

    expect(
      await gate.authorize(context(), {
        requiredGroupCapabilities: ["onboarding"],
        allowedPlayerAccess: ["ACTIVE"],
      }),
    ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
  });

  it("fails closed for unknown groups before granting a scoped command", async () => {
    const gate = new RuntimeCommandPolicyGate(dependencies({ group: "UNKNOWN" }));

    expect(
      await gate.authorize(context(), {
        requiredGroupCapabilities: ["onboarding"],
        allowedPlayerAccess: ["PENDING"],
      }),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
  });

  it("allows world commands only for ACTIVE mechanically complete players in a world-capable group", async () => {
    const ready = new RuntimeCommandPolicyGate(
      dependencies({ player: "ACTIVE_COMPLETE", group: "WORLD" }),
    );
    expect(
      await ready.authorize(context({ chatRef: "world@g.us" }), {
        requiredGroupCapabilities: ["world"],
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      }),
    ).toEqual(ok(undefined));

    const incomplete = new RuntimeCommandPolicyGate(
      dependencies({ player: "ACTIVE_INCOMPLETE", group: "WORLD" }),
    );
    expect(
      await incomplete.authorize(context({ chatRef: "world@g.us" }), {
        requiredGroupCapabilities: ["world"],
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("requires an actual RPG admin capability rather than WhatsApp group status", async () => {
    const denied = new RuntimeCommandPolicyGate(dependencies({ adminCapabilities: [] }));
    expect(
      await denied.authorize(context(), {
        requiredGroupCapabilities: ["onboarding"],
        requiredAdminCapability: "player.registration.approve",
      }),
    ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });

    const allowed = new RuntimeCommandPolicyGate(
      dependencies({ adminCapabilities: ["player.registration.approve"] }),
    );
    expect(
      await allowed.authorize(context(), {
        requiredGroupCapabilities: ["onboarding"],
        requiredAdminCapability: "player.registration.approve",
      }),
    ).toEqual(ok(undefined));
  });
});
