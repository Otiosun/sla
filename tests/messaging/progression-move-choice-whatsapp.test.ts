import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  createProgressionWhatsAppRoutes,
  type ProgressionWhatsAppDependencies,
} from "../../src/modules/progression/whatsapp-handlers.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";
const CHOICE_ID = "00000000-0000-4000-8000-000000000035";
const NEW_MOVE_ID = "00000000-0000-4000-8000-000000000045";

function context(text: string, id = "msg-1"): MessageHandlerContext {
  return {
    inboxMessageId: `inbox-${id}`,
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: `inbox-${id}`,
    idempotencyKey: `inbox:test:${id}`,
    message: {
      provider: "test",
      externalMessageId: id,
      senderRef: "player:test",
      chatRef: "chat:test",
      occurredAt: "2026-09-20T02:00:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function deps(activeBattleId: string | null = null): ProgressionWhatsAppDependencies {
  return {
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE", created: false }),
      ),
    },
    reads: {
      activeBattleId: vi.fn(async () => activeBattleId),
      listPendingMoveChoices: vi.fn(async () => [
        {
          choiceId: CHOICE_ID,
          pokemonInstanceId: POKEMON_ID,
          pokemonDisplayName: "Charmander",
          learnLevel: 13,
          moveId: NEW_MOVE_ID,
          moveDisplayName: "Metal Claw",
          currentMoves: [
            { slotNo: 1, moveId: "move-1", displayName: "Scratch" },
            { slotNo: 2, moveId: "move-2", displayName: "Growl" },
            { slotNo: 3, moveId: "move-3", displayName: "Ember" },
            { slotNo: 4, moveId: "move-4", displayName: "Smokescreen" },
          ],
        },
      ]),
    },
    progression: {
      resolveMoveChoice: vi.fn(async (input: unknown) => {
        const value = input as { replaceSlotNo: number | null };
        return ok({
          choiceId: CHOICE_ID,
          pokemonInstanceId: POKEMON_ID,
          moveId: NEW_MOVE_ID,
          status: value.replaceSlotNo === null ? "SKIPPED" : "RESOLVED",
          replacedSlotNo: value.replaceSlotNo,
          replayed: false,
        });
      }),
    },
  } as unknown as ProgressionWhatsAppDependencies;
}

function textOf(result: Awaited<ReturnType<MessageRouter["dispatch"]>>): string {
  if (!result.ok) throw new Error(`expected success: ${result.error.code}`);
  const payload = result.value?.outgoing[0]?.payload;
  return typeof payload?.text === "string" ? payload.text : "";
}

describe("progression WhatsApp move choices", () => {
  it("renders pending move choices with WhatsApp hierarchy and no UUIDs", async () => {
    const d = deps();
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));
    const output = textOf(await router.dispatch(context("/golpes")));
    expect(output).toContain("*MOVIMENTOS · APRENDIZADO*");
    expect(output).toContain("*1. Charmander* · Nv. 13");
    expect(output).toContain("*Metal Claw*");
    expect(output).toContain("`3`　Ember");
    expect(output).toContain("`/aprender 1 <1-4>`");
    expect(output).not.toContain(CHOICE_ID);
    expect(output).not.toContain(POKEMON_ID);
  });

  it("replaces a selected slot through ProgressionService", async () => {
    const d = deps();
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));
    const output = textOf(await router.dispatch(context("/aprender 1 3", "replace")));
    expect(d.progression.resolveMoveChoice).toHaveBeenCalledWith({
      choiceId: CHOICE_ID,
      playerId: PLAYER_ID,
      replaceSlotNo: 3,
      correlationId: "00000000-0000-4000-8000-000000000031",
    });
    expect(output).toContain("*Charmander* aprendeu *Metal Claw*");
    expect(output).toContain("`3`　~Ember~ → *Metal Claw*");
  });

  it("allows the player to skip a pending move", async () => {
    const d = deps();
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));
    const output = textOf(await router.dispatch(context("/aprender 1 pular", "skip")));
    expect(d.progression.resolveMoveChoice).toHaveBeenCalledWith(
      expect.objectContaining({ replaceSlotNo: null }),
    );
    expect(output).toContain("não aprendeu *Metal Claw*");
  });

  it("blocks loadout changes during an active battle", async () => {
    const d = deps("battle-active");
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));
    const result = await router.dispatch(context("/aprender 1 2", "battle"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FLOW_BLOCKED");
    expect(d.progression.resolveMoveChoice).not.toHaveBeenCalled();
  });
});
