import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import {
  createOperationalUxRoutes,
  type OperationalUxDependencies,
} from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

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
      replayTravelByIdempotency: vi.fn(async () => ok(null)),
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
      teamPokemonDetail: vi.fn(async () => ({
        pokemonInstanceId: POKEMON_ID,
        slotNo: 1,
        displayName: "Charmander",
        nickname: null,
        level: 5,
        currentHp: 0,
        maxHp: 20,
        gender: "MALE",
        shiny: false,
        natureDisplayName: "Adamant",
        abilityDisplayName: "Blaze",
        ivs: { hp: 31, attack: 30, defense: 29, spAttack: 12, spDefense: 18, speed: 27 },
        statuses: [],
        moves: [
          { slotNo: 1, displayName: "Scratch", ppCurrent: 35, maxPp: 35 },
          { slotNo: 2, displayName: "Growl", ppCurrent: 40, maxPp: 40 },
        ],
      })),
      listPendingMoveChoices: vi.fn(async () => []),
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
  it("presents the WORLD Rotom menu without automatic exploration", async () => {
    const deps = dependencies();
    (deps.reads.activeBattleId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (deps.encounter.activeForPlayer as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(appError("NOT_FOUND", "No active encounter")),
    );

    const output = textOf(await router(deps).dispatch(context("/menu")));
    expect(output).toContain("ROTOM · MENU");
    expect(output).toContain("/onde");
    expect(output).toContain("/evolucao <# ou nome>");
    expect(output).toContain("Explorações são conduzidas em cena pelo narrador");
    expect(output).not.toContain("/explorar");
    expect(output).not.toContain("revision");
  });

  it("prioritizes BATTLE then ENCOUNTER then FACILITY before WORLD", async () => {
    const battleDeps = dependencies();
    expect(textOf(await router(battleDeps).dispatch(context("/menu", "menu-battle")))).toContain(
      "ROTOM · BATALHA",
    );

    const encounterDeps = dependencies();
    (encounterDeps.reads.activeBattleId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(
      textOf(await router(encounterDeps).dispatch(context("/menu", "menu-encounter"))),
    ).toContain("ROTOM · ENCONTRO");

    const facilityDeps = dependencies({
      sessions: {
        loadActiveSession: vi.fn(async () =>
          ok({
            serviceKind: "POKEMART",
          }),
        ),
      },
    });
    (facilityDeps.reads.activeBattleId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (facilityDeps.encounter.activeForPlayer as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(appError("NOT_FOUND", "No active encounter")),
    );
    expect(
      textOf(await router(facilityDeps).dispatch(context("/menu", "menu-facility"))),
    ).toContain("ROTOM · POKÉ MART");
  });

  it("renders profile, team, inventory and Pokedex as readable mobile text", async () => {
    const app = router(dependencies());
    expect(textOf(await app.dispatch(context("/perfil", "profile")))).toContain("Treinador: *Red*");
    expect(textOf(await app.dispatch(context("/equipe", "team")))).toContain(
      "*Charmander* · Nv. 5 · HP 19",
    );
    expect(textOf(await app.dispatch(context("/inventario", "inventory")))).toContain("Potion ×3");
    expect(textOf(await app.dispatch(context("/pokedex", "pokedex")))).toContain(
      "#0004 Charmander · vistos 2 · capturados 1",
    );
  });

  it("shows persisted Pokemon mechanics without exposing internal ids", async () => {
    const output = textOf(await router(dependencies()).dispatch(context("/pokemon 1", "pokemon")));
    expect(output).toContain("*POKÉMON*");
    expect(output).toContain("_Charmander_");
    expect(output).toContain("HP　`0/20`");
    expect(output).toContain("`CAÍDO`");
    expect(output).toContain("*NATURE*　Adamant");
    expect(output).toContain("*ABILITY*　Blaze");
    expect(output).toContain("HP `31` · Atk `30` · Def `29`");
    expect(output).toContain("`1`　*Scratch* · PP 35/35");
    expect(output).not.toContain(POKEMON_ID);
  });

  it("accepts collection hash and unique Pokemon name references", async () => {
    const deps = dependencies();
    Object.assign(deps.reads, {
      listOwnedPokemon: vi.fn(async () => [
        {
          collectionNo: 13,
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          nickname: null,
          level: 5,
          xp: 0n,
          currentHp: 19,
          placementKind: "BOX" as const,
          boxNo: 1,
          slotNo: 7,
        },
      ]),
      ownedPokemonDetail: vi.fn(async (_playerId: string, collectionNo: number) =>
        collectionNo === 13
          ? {
              collectionNo: 13,
              pokemonInstanceId: POKEMON_ID,
              slotNo: 7,
              displayName: "Charmander",
              nickname: null,
              level: 5,
              xp: 0n,
              currentHp: 19,
              maxHp: 20,
              gender: "MALE" as const,
              shiny: false,
              natureDisplayName: "Adamant",
              abilityDisplayName: "Blaze",
              ivs: {
                hp: 31,
                attack: 30,
                defense: 29,
                spAttack: 12,
                spDefense: 18,
                speed: 27,
              },
              statuses: [],
              moves: [{ slotNo: 1, displayName: "Scratch", ppCurrent: 35, maxPp: 35 }],
              placementKind: "BOX" as const,
              boxNo: 1,
            }
          : null,
      ),
    });
    const app = router(deps);

    const byHash = textOf(await app.dispatch(context("/pokemon #13", "pokemon-hash")));
    const byName = textOf(await app.dispatch(context("/pokemon Charmander", "pokemon-name")));

    expect(byHash).toContain("#13");
    expect(byHash).toContain("_Charmander_");
    expect(byName).toContain("#13");
    expect(byName).toContain("_Charmander_");
  });

  it("rejects ambiguous Pokemon names and asks for collection numbers", async () => {
    const deps = dependencies();
    const detail = vi.fn();
    Object.assign(deps.reads, {
      listOwnedPokemon: vi.fn(async () => [
        {
          collectionNo: 13,
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          nickname: null,
          level: 5,
          xp: 0n,
          currentHp: 19,
          placementKind: "BOX" as const,
          boxNo: 1,
          slotNo: 7,
        },
        {
          collectionNo: 14,
          pokemonInstanceId: "00000000-0000-4000-8000-000000000026",
          displayName: "Charmander",
          nickname: null,
          level: 6,
          xp: 0n,
          currentHp: 20,
          placementKind: "BOX" as const,
          boxNo: 1,
          slotNo: 8,
        },
      ]),
      ownedPokemonDetail: detail,
    });

    const result = await router(deps).dispatch(
      context("/pokemon Charmander", "pokemon-ambiguous"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("#13");
    expect(result.error.message).toContain("#14");
    expect(detail).not.toHaveBeenCalled();
  });

  it("moves a boxed Pokemon into the team by human name reference", async () => {
    const deps = dependencies();
    (deps.reads.activeBattleId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (deps.encounter.activeForPlayer as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(appError("NOT_FOUND", "No active encounter")),
    );
    Object.assign(deps.reads, {
      listOwnedPokemon: vi.fn(async () => [
        {
          collectionNo: 13,
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          nickname: null,
          level: 5,
          xp: 0n,
          currentHp: 19,
          placementKind: "BOX" as const,
          boxNo: 1,
          slotNo: 7,
        },
      ]),
    });
    const move = vi.fn(async () => ok({}));
    Object.assign(deps, {
      pcStorage: {
        getStorage: vi.fn(async () =>
          ok({
            playerId: PLAYER_ID,
            team: [],
            boxes: [
              {
                boxNo: 1,
                occupied: 1,
                capacity: 30,
                pokemon: [
                  {
                    pokemonInstanceId: POKEMON_ID,
                    displayName: "Charmander",
                    level: 5,
                    placementKind: "BOX" as const,
                    boxNo: 1,
                    slotNo: 7,
                  },
                ],
              },
            ],
          }),
        ),
        move,
      },
    });

    const result = await router(deps).dispatch(
      context("/equipe colocar Charmander 2", "team-human-name"),
    );

    expect(result.ok).toBe(true);
    expect(move).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    });
  });

  it("stores a team Pokemon by collection hash without exposing its internal id", async () => {
    const deps = dependencies();
    (deps.reads.activeBattleId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (deps.encounter.activeForPlayer as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(appError("NOT_FOUND", "No active encounter")),
    );
    Object.assign(deps.reads, {
      listOwnedPokemon: vi.fn(async () => [
        {
          collectionNo: 13,
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          nickname: null,
          level: 5,
          xp: 0n,
          currentHp: 19,
          placementKind: "TEAM" as const,
          boxNo: null,
          slotNo: 1,
        },
      ]),
    });
    const move = vi.fn(async () => ok({}));
    Object.assign(deps, {
      pcStorage: {
        getStorage: vi.fn(async () =>
          ok({
            playerId: PLAYER_ID,
            team: [
              {
                pokemonInstanceId: POKEMON_ID,
                displayName: "Charmander",
                level: 5,
                placementKind: "TEAM" as const,
                boxNo: null,
                slotNo: 1,
              },
            ],
            boxes: [],
          }),
        ),
        move,
      },
    });

    const result = await router(deps).dispatch(
      context("/equipe guardar #13", "team-human-hash"),
    );

    expect(result.ok).toBe(true);
    expect(move).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
    });
    expect(textOf(result)).not.toContain(POKEMON_ID);
  });

  it("keeps route slugs and revisions internal while /ir uses the visible route number", async () => {
    const deps = dependencies();
    const app = router(deps);

    const whereText = textOf(await app.dispatch(context("/onde", "where")));
    expect(whereText).toContain("`/ir 1`");
    expect(whereText).toContain("*Route 1*");
    expect(whereText).not.toContain("route-1");
    expect(whereText).not.toContain("v7");

    const valid = await app.dispatch(context("/ir 1", "travel"));
    expect(valid.ok).toBe(true);
    expect(deps.world.replayTravelByIdempotency).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      idempotencyKey: "inbox:test:travel",
    });
    expect(deps.world.travel).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: PLAYER_ID,
        destinationAreaId: "area-route-1",
        expectedRevision: 7n,
        idempotencyKey: "inbox:test:travel",
      }),
    );
  });

  it("renders compact battle state without dumping moves or legal actions", async () => {
    const output = textOf(await router(dependencies()).dispatch(context("/batalha")));
    expect(output).toContain("Turno 3");
    expect(output).not.toContain("v9");
    expect(output).toContain("HP 21/30");
    expect(output).toContain("HP 10/18");
    expect(output).toContain("status PARALYSIS");
    expect(output).not.toContain("Tackle");
    expect(output).not.toContain("Growl");
    expect(output).not.toContain("PP 31/35");
    expect(output).not.toContain("usar Tackle");
    expect(output).not.toContain("tentar fugir");
  });
});
