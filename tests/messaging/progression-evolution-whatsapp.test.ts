import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { OperationalEvolutionOptionView } from "../../src/modules/messaging/operational-ux-read-model.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  createProgressionWhatsAppRoutes,
  type ProgressionWhatsAppDependencies,
} from "../../src/modules/progression/whatsapp-handlers.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";
const ITEM_ID = "00000000-0000-4000-8000-000000000045";
const FROM_FORM_ID = "00000000-0000-4000-8000-000000000055";
const TO_FORM_ID = "00000000-0000-4000-8000-000000000065";

function context(text: string, id = "msg-evolution"): MessageHandlerContext {
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
      occurredAt: "2026-09-22T21:00:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function owned(displayName = "Eevee") {
  return [
    {
      collectionNo: 13,
      pokemonInstanceId: POKEMON_ID,
      displayName,
      nickname: null,
      level: 20,
      xp: 0n,
      currentHp: 50,
      placementKind: "TEAM" as const,
      boxNo: null,
      slotNo: 1,
    },
  ];
}

function itemEvolution(quantity = 2n) {
  return [
    {
      targetDisplayName: "Vaporeon",
      triggerKind: "ITEM" as const,
      requiredLevel: null,
      relativePhysicalStats: null,
      itemId: ITEM_ID,
      itemDisplayName: "Water Stone",
      itemQuantity: quantity,
      conditionActive: null,
    },
  ];
}

function deps(options?: {
  readonly battle?: boolean;
  readonly encounter?: boolean;
  readonly travel?: boolean;
  readonly evolutionOptions?: readonly OperationalEvolutionOptionView[];
  readonly pokemonName?: string;
}): ProgressionWhatsAppDependencies {
  const evolvePokemon = vi.fn(async () =>
    ok({
      pokemonInstanceId: POKEMON_ID,
      fromFormId: FROM_FORM_ID,
      toFormId: TO_FORM_ID,
      triggerKind: "ITEM" as const,
      beforeLevel: 20,
      afterLevel: 20,
      replayed: false,
    }),
  );

  return {
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE", created: false }),
      ),
    },
    reads: {
      activeBattleId: vi.fn(async () => (options?.battle === true ? "battle-active" : null)),
      listPendingMoveChoices: vi.fn(async () => []),
      listOwnedPokemon: vi.fn(async () => owned(options?.pokemonName)),
      listEvolutionOptions: vi.fn(async () => options?.evolutionOptions ?? itemEvolution()),
    },
    progression: {
      resolveMoveChoice: vi.fn(),
      evolvePokemon,
    },
    encounter: {
      activeForPlayer: vi.fn(async () =>
        options?.encounter === true
          ? ok({
              encounterId: "00000000-0000-4000-8000-000000000075",
              playerId: PLAYER_ID,
              areaId: "00000000-0000-4000-8000-000000000085",
              status: "PRESENTED" as const,
              contentReleaseId: "00000000-0000-4000-8000-000000000095",
              rulesetId: "00000000-0000-4000-8000-000000000105",
              creationIdempotencyKey: "encounter",
              rngCounter: 0n,
              revision: 1n,
              createdAt: new Date("2026-09-22T20:00:00Z"),
              updatedAt: new Date("2026-09-22T20:00:00Z"),
              expiresAt: null,
              closedAt: null,
              snapshot: {
                speciesId: "00000000-0000-4000-8000-000000000115",
                formId: "00000000-0000-4000-8000-000000000125",
                level: 5,
                currentHp: 20,
                maxHp: 20,
              },
              battleId: null,
            })
          : err(appError("NOT_FOUND", "Player has no active encounter")),
      ),
    },
    world: {
      travelLock: vi.fn(async () =>
        ok(
          options?.travel === true
            ? {
                playerId: PLAYER_ID,
                destinationAreaId: "00000000-0000-4000-8000-000000000135",
                availableAt: "2026-09-22T22:00:00.000Z",
              }
            : null,
        ),
      ),
    },
  } as unknown as ProgressionWhatsAppDependencies;
}

function textOf(result: Awaited<ReturnType<MessageRouter["dispatch"]>>): string {
  if (!result.ok) throw new Error(`expected success: ${result.error.code}`);
  const payload = result.value?.outgoing[0]?.payload;
  return typeof payload?.text === "string" ? payload.text : "";
}

describe("progression WhatsApp evolution UX", () => {
  it("shows real item evolution requirements by human Pokemon name without internal ids", async () => {
    const d = deps();
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));

    const output = textOf(await router.dispatch(context("/evolucao Eevee", "evolution-info")));

    expect(output).toContain("#13 · *Eevee* · Nv. 20");
    expect(output).toContain("*1. Vaporeon*");
    expect(output).toContain("Water Stone · mochila ×2");
    expect(output).toContain("`/evoluir #13 1`");
    expect(output).not.toContain(POKEMON_ID);
    expect(output).not.toContain(ITEM_ID);
  });

  it("describes level evolution as automatic and never mutates it manually", async () => {
    const levelOption = [
      {
        targetDisplayName: "Charmeleon",
        triggerKind: "LEVEL" as const,
        requiredLevel: 16,
        relativePhysicalStats: null,
        itemId: null,
        itemDisplayName: null,
        itemQuantity: null,
        conditionActive: null,
      },
    ];
    const d = deps({ evolutionOptions: levelOption, pokemonName: "Charmander" });
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));

    const info = textOf(await router.dispatch(context("/evolucao Charmander", "level-info")));
    expect(info).toContain("Nível 16 · evolução automática");

    const result = await router.dispatch(context("/evoluir Charmander 1", "level-mutation"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(d.progression.evolvePokemon).not.toHaveBeenCalled();
  });

  it("evolves with the selected item through ProgressionService", async () => {
    const d = deps();
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));

    const output = textOf(await router.dispatch(context("/evoluir Eevee 1", "item-evolution")));

    expect(d.progression.evolvePokemon).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      idempotencyKey: "inbox:test:item-evolution",
      correlationId: "00000000-0000-4000-8000-000000000031",
      trigger: { kind: "ITEM", itemId: ITEM_ID },
    });
    expect(output).toContain("*Eevee* evoluiu para *Vaporeon*");
    expect(output).toContain("`/pokemon #13`");
    expect(output).not.toContain(POKEMON_ID);
    expect(output).not.toContain(ITEM_ID);
  });

  it("does not call the domain mutation when the required item is absent", async () => {
    const d = deps({ evolutionOptions: itemEvolution(0n) });
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));

    const result = await router.dispatch(context("/evoluir #13 1", "missing-item"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACTION_INVALID");
    expect(result.error.details?.userMessage).toContain("Water Stone");
    expect(d.progression.evolvePokemon).not.toHaveBeenCalled();
  });

  it.each([
    ["batalha", { battle: true }, "Finalize a batalha"],
    ["encontro", { encounter: true }, "Resolva o encontro"],
    ["viagem", { travel: true }, "Aguarde o fim da viagem"],
  ] as const)("blocks item evolution during %s", async (_label, state, expectedMessage) => {
    const d = deps(state);
    const router = new MessageRouter(createProgressionWhatsAppRoutes(d));

    const result = await router.dispatch(context("/evoluir #13 1", `blocked-${_label}`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FLOW_BLOCKED");
    expect(result.error.details?.userMessage).toContain(expectedMessage);
    expect(d.progression.evolvePokemon).not.toHaveBeenCalled();
  });
});
