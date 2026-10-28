import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { OperationalEvolutionOptionView } from "../../src/modules/messaging/operational-ux-read-model.js";
import {
  createProgressionWhatsAppRoutes,
  type ProgressionWhatsAppDependencies,
} from "../../src/modules/progression/whatsapp-handlers.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const itemA = randomUUID();
const itemB = randomUUID();

function option(
  targetDisplayName: string,
  kind: OperationalEvolutionOptionView["triggerKind"],
  itemId: string | null = null,
): OperationalEvolutionOptionView {
  return {
    targetDisplayName,
    triggerKind: kind,
    itemId,
    itemDisplayName: itemId === null ? null : "Pedra de teste",
    itemQuantity: itemId === null ? null : 2n,
    requiredLevel: kind === "LEVEL" ? 16 : null,
    relativePhysicalStats: null,
    conditionActive: kind === "CONDITION" ? true : null,
  };
}

function fixture(options: readonly OperationalEvolutionOptionView[]) {
  const evolvePokemon = vi.fn(async () =>
    ok({
      pokemonInstanceId, fromFormId: randomUUID(), toFormId: randomUUID(),
      triggerKind: "ITEM" as const, beforeLevel: 16, afterLevel: 16, replayed: false,
    }),
  );
  const dependencies = {
    players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
    reads: {
      listOwnedPokemon: async () => [{
        collectionNo: 1, pokemonInstanceId, displayName: "Eevee", nickname: null,
        level: 16, xp: 0n, currentHp: 32, placementKind: "TEAM", boxNo: null, slotNo: 1,
      }],
      listEvolutionOptions: async () => options,
      listPendingMoveChoices: async () => [],
      activeBattleId: async () => null,
    },
    progression: { evolvePokemon, resolveMoveChoice: vi.fn() },
  } as unknown as ProgressionWhatsAppDependencies;
  const routes = createProgressionWhatsAppRoutes(dependencies);

  async function send(command: string) {
    const route = routes.find((r) => r.command === command.split(" ")[0].slice(1));
    if (!route) throw new Error("Missing progression route");
    const context = {
      inboxMessageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      idempotencyKey: `test:${randomUUID()}`,
      message: {
        provider: "baileys", externalMessageId: randomUUID(),
        senderRef: "5599999999001", chatRef: "test@g.us",
        occurredAt: "2026-10-28T12:00:00-03:00", text: command,
        mediaRefs: [], replyToExternalMessageId: null,
      },
    } as MessageHandlerContext;
    return route.handler.handle(context);
  }
  return { send, evolvePokemon };
}

describe("WhatsApp manual evolution with indistinguishable destinations", () => {
  it("does not advertise or execute ambiguous ITEM destinations", async () => {
    const { send, evolvePokemon } = fixture([
      option("Forma A", "ITEM", itemA),
      option("Forma B", "ITEM", itemA),
    ]);
    const listing = await send("/evolucao #1");
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error(listing.error.message);
    const text = listing.value.outgoing[0]?.payload.text;
    expect(text).toContain("Forma A");
    expect(text).toContain("Forma B");
    expect(text).toContain("Indisponível: vários destinos usam o mesmo gatilho");
    expect(text).not.toContain("/evoluir #1");
    for (const command of ["/evoluir #1 1", "/evoluir #1 2"]) {
      const result = await send(command);
      expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    }
    expect(evolvePokemon).not.toHaveBeenCalled();
  });

  it("does not offer a choice between indistinguishable CONDITION destinations", async () => {
    const { send, evolvePokemon } = fixture([
      option("Forma C", "CONDITION"),
      option("Forma D", "CONDITION"),
    ]);
    const listing = await send("/evolucao #1");
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error(listing.error.message);
    expect(listing.value.outgoing[0]?.payload.text).not.toContain("/evoluir #1");
    const result = await send("/evoluir #1 2");
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(evolvePokemon).not.toHaveBeenCalled();
  });

  it("still allows distinguishable item rules and preserves automatic LEVEL", async () => {
    const { send, evolvePokemon } = fixture([
      option("Ivysaur", "LEVEL"),
      option("Forma A", "ITEM", itemA),
      option("Forma B", "ITEM", itemB),
    ]);
    const listing = await send("/evolucao #1");
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error(listing.error.message);
    expect(listing.value.outgoing[0]?.payload.text).toContain("evolução automática");
    expect(listing.value.outgoing[0]?.payload.text).toContain("/evoluir #1 2");
    expect(listing.value.outgoing[0]?.payload.text).toContain("/evoluir #1 3");
    const level = await send("/evoluir #1 1");
    expect(level.ok).toBe(false);
    const item = await send("/evoluir #1 2");
    expect(item.ok).toBe(true);
    expect(evolvePokemon).toHaveBeenCalledTimes(1);
    expect(evolvePokemon.mock.calls[0]?.[0].trigger).toEqual({ kind: "ITEM", itemId: itemA });
  });
});
