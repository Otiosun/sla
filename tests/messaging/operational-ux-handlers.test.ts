import { describe, expect, it, vi } from "vitest";
import {
  createOperationalUxRoutes,
  type OperationalUxDependencies,
} from "../../src/modules/messaging/operational-ux-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";

function context(text: string, id = "message-1"): MessageHandlerContext {
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
      occurredAt: "2026-08-28T03:00:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function textOf(result: Awaited<ReturnType<MessageRouter["dispatch"]>>): string {
  if (!result.ok) throw new Error(`Expected successful route, got ${result.error.code}`);
  const payload = result.value?.outgoing[0]?.payload;
  return typeof payload?.text === "string" ? payload.text : "";
}

function dependencies(overrides: Record<string, unknown> = {}): OperationalUxDependencies {
  const base = {
    registration: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE", created: false }),
      ),
      resolveOrCreatePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE", created: false }),
      ),
      createProfile: vi.fn(async () => ok({ playerId: PLAYER_ID, state: "PROFILE_CREATED" })),
      selectRegion: vi.fn(async () => ok({ playerId: PLAYER_ID, state: "REGION_SELECTED" })),
    },
    starter: {
      listStarterOptions: vi.fn(async () => ok([])),
      prepareStarterSelection: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, starterClaimKey: "claim", options: [] }),
      ),
      grantStarter: vi.fn(),
      completeOnboarding: vi.fn(async () => ok({ playerId: PLAYER_ID, state: "COMPLETE" })),
      getProfile: vi.fn(async () =>
        ok({
          playerId: PLAYER_ID,
          playerStatus: "ACTIVE",
          trainerName: "Red",
          originRegionId: "region-kanto",
          locale: "pt-BR",
          trainerLevel: 3,
          progressionPoints: 240n,
          onboardingState: "COMPLETE",
          contentReleaseId: "release-1",
          rulesetId: "ruleset-1",
          starterPokemonInstanceId: POKEMON_ID,
          team: [],
        }),
      ),
    },
    world: {
      ensureInitialLocation: vi.fn(),
      getLocation: vi.fn(async () =>
        ok({
          playerId: PLAYER_ID,
          areaId: "area-pallet",
          areaSlug: "pallet-town",
          areaDisplayName: "Pallet Town",
          regionId: "region-kanto",
          regionSlug: "kanto",
          regionDisplayName: "Kanto",
          contentReleaseId: "release-1",
          revision: 7n,
          connections: [
            {
              connectionId: "connection-route-1",
              destinationAreaId: "area-route-1",
              destinationSlug: "route-1",
              destinationDisplayName: "Route 1",
              available: true,
              blockedReason: null,
            },
          ],
        }),
      ),
      replayTravelIfCommitted: vi.fn(async () => ok(null)),
      travel: vi.fn(async () =>
        ok({
          replayed: false,
          from: { areaId: "area-pallet", areaDisplayName: "Pallet Town", revision: 7n },
          to: { areaId: "area-route-1", areaDisplayName: "Route 1", revision: 8n },
        }),
      ),
    },
    encounter: {
      activeForPlayer: vi.fn(async () =>
        ok({
          encounterId: "00000000-0000-4000-8000-000000000041",
          playerId: PLAYER_ID,
          areaId: "area-route-1",
          status: "PRESENTED",
          contentReleaseId: "release-1",
          rulesetId: "ruleset-1",
          creationIdempotencyKey: "encounter-1",
          rngCounter: 0n,
          revision: 2n,
          createdAt: new Date("2026-08-28T06:00:00Z"),
          updatedAt: new Date("2026-08-28T06:00:00Z"),
          expiresAt: null,
          closedAt: null,
          snapshot: {
            speciesId: "species-pidgey",
            formId: "form-pidgey",
            level: 4,
            currentHp: 15,
            maxHp: 15,
          },
          battleId: null,
        }),
      ),
    },
    battle: {
      forPlayer: vi.fn(async () =>
        ok({
          playerSideNo: 1,
          legalActions: [
            {
              type: "USE_MOVE",
              actorParticipantId: "own",
              moveSlot: 1,
              targetParticipantId: "wild",
            },
            { type: "FLEE", actorParticipantId: "own" },
          ],
          state: {
            battleId: "battle-1",
            status: "ACTIVE",
            contentReleaseId: "release-1",
            rulesetId: "ruleset-1",
            turnNumber: 3,
            version: 9n,
            sides: [
              {
                sideNo: 1,
                controllerKind: "PLAYER",
                playerId: PLAYER_ID,
                activeParticipantId: "own",
                result: null,
              },
              {
                sideNo: 2,
                controllerKind: "WILD",
                playerId: null,
                activeParticipantId: "wild",
                result: null,
              },
            ],
            combatants: [
              {
                participantId: "own",
                sideNo: 1,
                rosterPosition: 1,
                currentHp: 21,
                maxHp: 30,
                majorStatus: null,
                moves: [
                  { slotNo: 1, moveId: "move-tackle", ppCurrent: 31, maxPp: 35 },
                  { slotNo: 2, moveId: "move-growl", ppCurrent: 40, maxPp: 40 },
                ],
              },
              {
                participantId: "wild",
                sideNo: 2,
                rosterPosition: 1,
                currentHp: 10,
                maxHp: 18,
                majorStatus: { key: "PARALYSIS" },
                moves: [],
              },
            ],
          },
        }),
      ),
    },
    reads: {
      listRegionOptions: vi.fn(async () => [{ regionId: "region-kanto", displayName: "Kanto" }]),
      listTeam: vi.fn(async () => [
        {
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          level: 5,
          currentHp: 19,
          slotNo: 1,
        },
      ]),
      listInventory: vi.fn(async () => [
        { itemId: "item-potion", itemSlug: "potion", displayName: "Potion", quantity: 3n },
      ]),
      listPokedex: vi.fn(async () => [
        {
          speciesId: "species-charmander",
          nationalDex: 4,
          speciesSlug: "charmander",
          displayName: "Charmander",
          seenCount: 2n,
          caughtCount: 1n,
        },
      ]),
      activeBattleId: vi.fn(async () => "battle-1"),
      speciesDisplayName: vi.fn(async () => "Pidgey"),
      moveDisplayNames: vi.fn(
        async () =>
          new Map([
            ["move-tackle", "Tackle"],
            ["move-growl", "Growl"],
          ]),
      ),
    },
  };
  return { ...base, ...overrides } as unknown as OperationalUxDependencies;
}

function router(deps: OperationalUxDependencies): MessageRouter {
  return new MessageRouter(createOperationalUxRoutes(deps));
}

describe("Phase 13 operational WhatsApp UX", () => {
  it("presents a compact complete-player menu without inventing automatic exploration", async () => {
    const output = textOf(await router(dependencies()).dispatch(context("$menu")));
    expect(output).toContain("CENTRAL DO TREINADOR");
    expect(output).toContain("$onde");
    expect(output).toContain("$encontro");
    expect(output).toContain("Cenas comuns continuam livres");
    expect(output).not.toContain("$explorar");
    expect(output).not.toContain("$golpe");
  });

  it("renders profile, team, inventory and Pokedex as readable mobile text", async () => {
    const app = router(dependencies());
    expect(textOf(await app.dispatch(context("$perfil", "profile")))).toContain("Treinador: *Red*");
    expect(textOf(await app.dispatch(context("$equipe", "team")))).toContain(
      "*Charmander* · Nv. 5 · HP 19",
    );
    expect(textOf(await app.dispatch(context("$inventario", "inventory")))).toContain("Potion ×3");
    expect(textOf(await app.dispatch(context("$pokedex", "pokedex")))).toContain(
      "#0004 Charmander · vistos 2 · capturados 1",
    );
  });

  it("emits revision-bound travel commands and rejects stale text before calling the owner mutation", async () => {
    const deps = dependencies();
    const app = router(deps);
    const whereText = textOf(await app.dispatch(context("$onde", "where")));
    expect(whereText).toContain("$ir route-1 v7");

    const stale = await app.dispatch(context("$ir route-1 v6", "stale"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("REVISION_CONFLICT");
    expect(deps.world.replayTravelIfCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: PLAYER_ID,
        destinationSlug: "route-1",
        expectedRevision: 6n,
        idempotencyKey: "inbox:test:stale",
      }),
    );
    expect(deps.world.travel).not.toHaveBeenCalled();

    const valid = await app.dispatch(context("$ir route-1 v7", "travel"));
    expect(valid.ok).toBe(true);
    expect(deps.world.travel).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: PLAYER_ID,
        destinationAreaId: "area-route-1",
        expectedRevision: 7n,
        idempotencyKey: "inbox:test:travel",
      }),
    );
  });

  it("keeps encounter presentation informational and narrator-controlled", async () => {
    const output = textOf(await router(dependencies()).dispatch(context("$encontro")));
    expect(output).toContain("Pidgey");
    expect(output).toContain("Nv. 4");
    expect(output).toContain("HP: 15/15");
    expect(output).toContain("condução do narrador");
    expect(output).toContain("não inicia combate automaticamente");
  });

  it("renders battle HP/status/PP and only actions supplied as mechanically legal", async () => {
    const output = textOf(await router(dependencies()).dispatch(context("$batalha")));
    expect(output).toContain("Turno 3 · v9");
    expect(output).toContain("HP 21/30");
    expect(output).toContain("HP 10/18 · status PARALYSIS");
    expect(output).toContain("Tackle · PP 31/35");
    expect(output).toContain("Growl · PP 40/40");
    expect(output).toContain("usar Tackle");
    expect(output).toContain("tentar fugir");
    expect(output).not.toContain("usar Growl\n");
    expect(output).toContain("não substitui a seleção explícita da ação narrativa");
  });
});
