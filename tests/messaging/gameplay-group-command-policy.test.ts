import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import { createPveBattleStartWhatsAppRoute } from "../../src/modules/battle/pve-battle-start.js";
import { createSpawnWhatsAppRoute } from "../../src/modules/encounter/spawn-whatsapp.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPvpWhatsAppRoutes } from "../../src/modules/pvp/whatsapp-handlers.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000741",
    correlationId: "00000000-0000-4000-8000-000000000742",
    causationId: "00000000-0000-4000-8000-000000000741",
    idempotencyKey: `group-command-policy:${command}`,
    message: {
      provider: "baileys",
      externalMessageId: "command-message",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363900001@g.us",
      occurredAt: "2026-10-23T03:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function router(input: {
  readonly capabilities?: readonly ("world" | "player.basic" | "pve" | "pvp")[];
  readonly admin?: readonly string[];
  readonly ready?: boolean;
  readonly known?: boolean;
}) {
  const capabilities = input.capabilities ?? (["player.basic", "pve", "pvp", "world"] as const);
  const invoked = vi.fn(async () => ok({ resultRefType: null, resultRefId: null, outgoing: [] }));
  const definitions = [
    createSpawnWhatsAppRoute({} as never),
    createPveBattleStartWhatsAppRoute({} as never),
    ...createPvpWhatsAppRoutes({} as never),
    ...createWorldServiceWhatsAppRoutes({} as never).filter((entry) =>
      ["comprar", "pescar"].includes(entry.command),
    ),
  ].map((entry) => ({
    ...entry,
    handler: { handle: invoked },
  }));
  const policy = new RuntimeCommandPolicyGate({
    community: {
      resolveChat: async () =>
        input.known === false
          ? { known: false as const, groupId: null, role: null, capabilities: [] }
          : {
              known: true as const,
              groupId: "00000000-0000-4000-8000-000000000743",
              role: "GAME" as const,
              capabilities,
            },
    },
    players: {
      resolvePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: input.ready === false ? "NEW" : "COMPLETE" }),
    },
    access: {
      load: async () => ({
        playerId: PLAYER_ID,
        status: "ACTIVE" as const,
        approvedReviewId: "00000000-0000-4000-8000-000000000744",
        revision: 2,
      }),
    },
    admins: {
      capabilitiesFor: async () => input.admin ?? [],
    },
  });
  return { router: new MessageRouter(definitions, policy), invoked };
}

describe("GAME group route admission for the reported WhatsApp commands", () => {
  it("admits player PvP and world services once /grupo jogo has provisioned capabilities", async () => {
    const setup = router({});
    for (const command of ["/desafiar", "/aceitar", "/comprar", "/pescar"]) {
      expect(await setup.router.dispatch(context(command))).toMatchObject({ ok: true });
    }
    expect(setup.invoked).toHaveBeenCalledTimes(4);
  });

  it("keeps narrator spawn and battle-start limited to RPG narrators", async () => {
    const ordinary = router({});
    for (const command of ["/spawn", "/iniciarbatalha"]) {
      expect(await ordinary.router.dispatch(context(command))).toMatchObject({
        ok: false,
        error: { code: "PLAYER_INELIGIBLE" },
      });
    }
    expect(ordinary.invoked).not.toHaveBeenCalled();

    for (const command of ["/spawn", "/iniciarbatalha"]) {
      const denied = await ordinary.router.dispatch(context(command));
      expect(denied).toMatchObject({
        ok: false,
        error: {
          details: {
            userMessage: expect.stringContaining("exclusivo dos narradores autorizados"),
          },
        },
      });
    }

    const narrator = router({ admin: ["encounter.support"] });
    for (const command of ["/spawn", "/iniciarbatalha"]) {
      expect(await narrator.router.dispatch(context(command))).toMatchObject({ ok: true });
    }
    expect(narrator.invoked).toHaveBeenCalledTimes(2);
  });

  it("fails closed in old unconfigured groups and for unprepared trainers", async () => {
    const oldGroup = router({ capabilities: ["player.basic", "world"] });
    expect(await oldGroup.router.dispatch(context("/desafiar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });

    const unknownGroup = router({ known: false });
    expect(await unknownGroup.router.dispatch(context("/pescar"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });

    const incomplete = router({ ready: false });
    for (const command of ["/desafiar", "/aceitar", "/comprar", "/pescar"]) {
      expect(await incomplete.router.dispatch(context(command))).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
    expect(incomplete.invoked).not.toHaveBeenCalled();
  });
});
