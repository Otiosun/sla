import { describe, expect, it } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import {
  type PlayerPortalActiveBattleRecord,
  PlayerPortalReadService,
} from "../../src/modules/player-portal/read-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const identity = { provider: "baileys", externalId: "player@test" } as const;

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: "11111111-1111-4111-8111-111111111111",
  locale: "pt-BR",
  trainerLevel: 3,
  progressionPoints: 240n,
  onboardingState: "COMPLETE",
  contentReleaseId: "22222222-2222-4222-8222-222222222222",
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: pokemonInstanceId,
  team: [],
};

function service(activeBattle: PlayerPortalActiveBattleRecord | null = null) {
  return new PlayerPortalReadService({
    players: {
      resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
    },
    profiles: {
      getProfile: async () => ok(profile),
    },
    world: {
      getLocation: async () =>
        ok({
          playerId,
          contentReleaseId: profile.contentReleaseId,
          areaId: "44444444-4444-4444-8444-444444444444",
          areaSlug: "vila-dos-arrozais",
          areaDisplayName: "Vila dos Arrozais",
          regionId: "55555555-5555-4555-8555-555555555555",
          regionSlug: "zhoulia",
          regionDisplayName: "Zhoulia",
          safePoint: true,
          revision: 7n,
          enteredAt: new Date("2026-09-18T20:00:00.000Z"),
          requiresRelocation: false,
          relocationAreaId: null,
          connections: [],
        }),
    },
    repository: {
      originRegionDisplayName: async () => "Zhoulia",
      listOwnedPokemon: async () => [
        {
          pokemonInstanceId,
          formId: "66666666-6666-4666-8666-666666666666",
          displayName: "Chikorita",
          nationalDex: 152,
          typeNames: ["Grass"],
          nickname: null,
          level: 5,
          xp: "12",
          xpToNextLevel: 91,
          currentHp: 20,
          maxHp: 21,
          natureDisplayName: "Calm",
          abilityDisplayName: "Overgrow",
          ivs: { hp: 31, attack: 12, defense: 27, spAttack: 18, spDefense: 29, speed: 20 },
          gender: "F",
          shiny: false,
          placementKind: "TEAM",
          boxNo: null,
          slotNo: 1,
          conditions: [],
          moves: [],
        },
      ],
      listPokedex: async () => [],
      listInventory: async () => [],
      activeBattle: async () => activeBattle,
    },
    presentation: {
      speciesDisplayName: async (_contentReleaseId, speciesId) =>
        speciesId === "77777777-7777-4777-8777-777777777777" ? "Chikorita" : "Rattata",
      moveDisplayNames: async () => new Map([["99999999-9999-4999-8999-999999999999", "Tackle"]]),
    },
  });
}

describe("PlayerPortalReadService", () => {
  it("uses current profile and collection owners for the companion self view", async () => {
    const result = await service().getSelf(identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      trainerName: "Natan",
      originRegionName: "Zhoulia",
      progressionPoints: "240",
      team: [
        {
          pokemonInstanceId,
          displayName: "Chikorita",
          currentHp: 20,
          maxHp: 21,
          slotNo: 1,
        },
      ],
    });
  });

  it("exposes current location read-only with serialized revision and timestamp", async () => {
    const result = await service().getLocation(identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual(
      expect.objectContaining({
        areaDisplayName: "Vila dos Arrozais",
        regionDisplayName: "Zhoulia",
        revision: "7",
        enteredAt: "2026-09-18T20:00:00.000Z",
      }),
    );
  });

  it("reports no active battle without inventing one", async () => {
    expect(await service().getBattle(identity)).toEqual({ ok: true, value: null });
  });

  it("returns a read-only battle summary without legal actions or participant ids", async () => {
    const result = await service({
      playerSideNo: 1,
      state: {
        schemaVersion: 1,
        battleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        battleType: "PVP",
        status: "ACTIVE",
        contentReleaseId: profile.contentReleaseId,
        rulesetId: profile.rulesetId,
        encounterId: null,
        turnNumber: 3,
        version: 9,
        rngCounter: "2",
        sides: [
          {
            sideNo: 1,
            controllerKind: "PLAYER",
            playerId,
            participantIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
            activeParticipantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            result: null,
          },
          {
            sideNo: 2,
            controllerKind: "PLAYER",
            playerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            participantIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
            activeParticipantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            result: null,
          },
        ],
        combatants: [
          {
            participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sideNo: 1,
            rosterPosition: 1,
            participantKind: "PLAYER_POKEMON",
            pokemonInstanceId,
            formId: "66666666-6666-4666-8666-666666666666",
            speciesId: "77777777-7777-4777-8777-777777777777",
            level: 5,
            type1Id: "88888888-8888-4888-8888-888888888888",
            type1Slug: "grass",
            type2Id: null,
            type2Slug: null,
            baseStats: {
              hp: 45,
              attack: 49,
              defense: 65,
              spAttack: 49,
              spDefense: 65,
              speed: 45,
            },
            ivs: { hp: 31, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
            nature: {
              natureId: "12121212-1212-4121-8121-121212121212",
              increasedStat: null,
              decreasedStat: null,
            },
            ability: {
              abilityId: "13131313-1313-4131-8131-131313131313",
              effectKey: null,
              effectConfig: {},
            },
            moves: [
              {
                slotNo: 1,
                moveId: "99999999-9999-4999-8999-999999999999",
                typeId: "88888888-8888-4888-8888-888888888888",
                typeSlug: "normal",
                category: "PHYSICAL",
                power: 40,
                accuracy: 100,
                priority: 0,
                maxPp: 35,
                ppCurrent: 34,
                effectKey: null,
                effectConfig: {},
                flags: { makesContact: true },
              },
            ],
            maxHp: 21,
            currentHp: 18,
            majorStatus: { key: "POISON", counter: null },
            stages: {
              attack: 0,
              defense: 0,
              spAttack: 0,
              spDefense: 0,
              speed: 0,
              accuracy: 0,
              evasion: 0,
            },
            volatile: { flinch: false, confusionTurns: 0 },
          },
          {
            participantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sideNo: 2,
            rosterPosition: 1,
            participantKind: "PLAYER_POKEMON",
            pokemonInstanceId: "14141414-1414-4141-8141-141414141414",
            formId: "15151515-1515-4151-8151-151515151515",
            speciesId: "16161616-1616-4161-8161-161616161616",
            level: 5,
            type1Id: "17171717-1717-4171-8171-171717171717",
            type1Slug: "normal",
            type2Id: null,
            type2Slug: null,
            baseStats: {
              hp: 30,
              attack: 56,
              defense: 35,
              spAttack: 25,
              spDefense: 35,
              speed: 72,
            },
            ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
            nature: {
              natureId: "18181818-1818-4181-8181-181818181818",
              increasedStat: null,
              decreasedStat: null,
            },
            ability: {
              abilityId: "19191919-1919-4191-8191-191919191919",
              effectKey: null,
              effectConfig: {},
            },
            moves: [],
            maxHp: 18,
            currentHp: 12,
            majorStatus: null,
            stages: {
              attack: 0,
              defense: 0,
              spAttack: 0,
              spDefense: 0,
              speed: 0,
              accuracy: 0,
              evasion: 0,
            },
            volatile: { flinch: false, confusionTurns: 0 },
          },
        ],
      },
    }).getBattle(identity);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;

    expect(result.value).toMatchObject({
      battleType: "PVP",
      turnNumber: 3,
      playerSideNo: 1,
      combatants: [
        {
          playerSide: true,
          displayName: "Chikorita",
          currentHp: 18,
          maxHp: 21,
          conditions: ["POISON"],
          moves: [{ slotNo: 1, displayName: "Tackle", ppCurrent: 34, maxPp: 35 }],
        },
        {
          playerSide: false,
          displayName: "Rattata",
          currentHp: 12,
          maxHp: 18,
        },
      ],
    });
    expect(result.value).not.toHaveProperty("legalActions");
    expect(JSON.stringify(result.value)).not.toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
