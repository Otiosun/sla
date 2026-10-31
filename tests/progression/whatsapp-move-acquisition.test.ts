import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { MoveTrainingService } from "../../src/modules/progression/move-training-service.js";
import {
  createProgressionWhatsAppRoutes,
  type ProgressionWhatsAppDependencies,
} from "../../src/modules/progression/whatsapp-handlers.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId(),
  pokemonInstanceId = createPokemonInstanceId();
const moveId = randomUUID(),
  itemId = randomUUID();

function setup(method: "REMINDER" | "TM", inCenter = true, activeBattle = false) {
  const learn = vi.fn<MoveTrainingService["learn"]>(async () =>
    ok({
      pokemonInstanceId,
      moveId,
      slotNo: 2,
      replacedMoveId: null,
      itemId: method === "TM" ? itemId : null,
      replayed: false,
    }),
  );
  const options = vi.fn<MoveTrainingService["options"]>(async () =>
    ok([
      {
        moveId,
        displayName: "Vine Whip",
        method,
        itemId: method === "TM" ? itemId : null,
        itemName: method === "TM" ? "TM Vine Whip" : null,
        itemQuantity: method === "TM" ? 2n : null,
      },
    ]),
  );
  const dependencies = {
    players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
    reads: {
      listOwnedPokemon: async () => [
        {
          collectionNo: 1,
          pokemonInstanceId,
          displayName: "Bulbasaur",
          nickname: null,
          level: 12,
          xp: 1n,
          currentHp: 30,
          placementKind: "TEAM",
          boxNo: null,
          slotNo: 1,
        },
      ],
      activeBattleId: async () => (activeBattle ? randomUUID() : null),
    },
    training: { options, learn },
    sessions: {
      loadActiveSession: async () =>
        ok(inCenter ? { serviceKind: "POKEMON_CENTER", state: "OPEN" } : null),
    },
  } as unknown as ProgressionWhatsAppDependencies;
  async function send(command: string) {
    const route = createProgressionWhatsAppRoutes(dependencies).find(
      (r) => r.command === (command.split(" ")[0] ?? "").slice(1),
    );
    if (route === undefined) throw Error("route missing");
    const context = {
      inboxMessageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      idempotencyKey: randomUUID(),
      message: {
        provider: "baileys",
        externalMessageId: randomUUID(),
        senderRef: "5511999999999",
        chatRef: "trainers@g.us",
        occurredAt: "2026-10-28T13:00:00-03:00",
        text: command,
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    } as MessageHandlerContext;
    return route.handler.handle(context);
  }
  return { send, learn, options };
}

describe("WhatsApp move acquisition across novice and advanced flows", () => {
  it("refuses move reminder outside the Pokémon Center", async () => {
    const { send, learn } = setup("REMINDER", false);
    const result = await send("/reaprender #1 1");
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(learn).not.toHaveBeenCalled();
  });

  it("offers free remembered moves and performs a no-item learn", async () => {
    const { send, learn } = setup("REMINDER");
    const menu = await send("/reaprender #1");
    expect(menu.ok).toBe(true);
    if (!menu.ok) throw Error(menu.error.message);
    expect(menu.value.outgoing[0]?.payload.text).toContain("Vine Whip");
    const result = await send("/reaprender #1 1");
    expect(result.ok).toBe(true);
    expect(learn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "REMINDER",
        itemId: null,
        replaceSlotNo: null,
      }),
    );
  });

  it("shows only eligible owned TMs and asks the service to consume the exact item", async () => {
    const { send, learn } = setup("TM");
    const menu = await send("/tms #1");
    expect(menu.ok).toBe(true);
    if (!menu.ok) throw Error(menu.error.message);
    expect(menu.value.outgoing[0]?.payload.text).toContain("TM Vine Whip ×2");
    const result = await send("/ensinar #1 1 2");
    expect(result.ok).toBe(true);
    expect(learn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "TM",
        itemId,
        moveId,
        replaceSlotNo: 2,
      }),
    );
  });

  it("does not mutate an invalid option or a move during active battle", async () => {
    const invalid = setup("TM");
    expect(await invalid.send("/ensinar #1 7")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(invalid.learn).not.toHaveBeenCalled();
    const battling = setup("TM", true, true);
    expect(await battling.send("/ensinar #1 1")).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(battling.learn).not.toHaveBeenCalled();
  });
});
