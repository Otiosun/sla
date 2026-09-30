import { describe, expect, it, vi } from "vitest";
import type { BattleCombatant } from "../../src/modules/battle/contracts.js";
import type { BattlePokemonBuild, BattleRootRecord } from "../../src/modules/battle/ports.js";
import { BattleService } from "../../src/modules/battle/service.js";
import { IDS, playerCombatant, wildCombatant } from "./fixtures.js";

function buildFromCombatant(combatant: BattleCombatant): BattlePokemonBuild {
  return {
    pokemonInstanceId: combatant.pokemonInstanceId,
    participantKind: combatant.participantKind,
    rosterPosition: combatant.rosterPosition,
    formId: combatant.formId,
    speciesId: combatant.speciesId,
    level: combatant.level,
    shiny: combatant.shiny ?? false,
    type1Id: combatant.type1Id,
    type1Slug: combatant.type1Slug,
    type2Id: combatant.type2Id,
    type2Slug: combatant.type2Slug,
    baseStats: { ...combatant.baseStats },
    ivs: { ...combatant.ivs },
    nature: { ...combatant.nature },
    ability: { ...combatant.ability },
    moves: combatant.moves.map((move) => ({
      slotNo: move.slotNo,
      moveId: move.moveId,
      typeId: move.typeId,
      typeSlug: move.typeSlug,
      category: move.category,
      power: move.power,
      accuracy: move.accuracy,
      priority: move.priority,
      maxPp: move.maxPp,
      ppCurrent: move.ppCurrent,
      effectKey: move.effectKey,
      effectConfig: structuredClone(move.effectConfig),
      makesContact: move.flags.makesContact,
    })),
    maxHp: combatant.maxHp,
    currentHp: combatant.currentHp,
    majorStatus: combatant.majorStatus?.key ?? null,
  };
}

function root(): BattleRootRecord {
  return {
    battleId: IDS.battle,
    battleType: "WILD",
    status: "CREATED",
    contentReleaseId: IDS.release,
    rulesetId: IDS.ruleset,
    encounterId: IDS.encounter,
    turnNumber: 0,
    version: 0,
    seed: {
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array([2]),
      authTag: new Uint8Array([3]),
      keyVersion: 1,
    },
    rngCounter: 0n,
    endedAt: null,
  };
}

describe("BattleService initialization initiative precedence", () => {
  it("keeps an explicit encounter initiative instead of replacing it with the first actor fallback", async () => {
    const storedRoot = root();
    const transaction = {
      loadRoot: vi.fn(async () => storedRoot),
      loadState: vi.fn(async () => null),
      loadInitializationData: vi.fn(async () => ({
        playerId: IDS.player,
        playerParty: [buildFromCombatant(playerCombatant())],
        opponentParty: [buildFromCombatant(wildCombatant())],
        firstTurnInitiative: "WILD" as const,
      })),
      initialize: vi.fn(async (_root: BattleRootRecord, state: unknown) => state),
    };
    const repository = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const ids = [IDS.p1, IDS.p2];
    let index = 0;
    const service = new BattleService(
      repository as never,
      {} as never,
      () =>
        ids[index++] ??
        (() => {
          throw new Error("id factory exhausted");
        })(),
    );

    const result = await service.initialize(IDS.battle, "PLAYER");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.firstTurnInitiative).toBe("WILD");
    expect(transaction.initialize).toHaveBeenCalledOnce();
  });

  it("uses the first actor fallback when the encounter did not pin an initiative", async () => {
    const storedRoot = root();
    const transaction = {
      loadRoot: vi.fn(async () => storedRoot),
      loadState: vi.fn(async () => null),
      loadInitializationData: vi.fn(async () => ({
        playerId: IDS.player,
        playerParty: [buildFromCombatant(playerCombatant())],
        opponentParty: [buildFromCombatant(wildCombatant())],
      })),
      initialize: vi.fn(async (_root: BattleRootRecord, state: unknown) => state),
    };
    const repository = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const ids = [IDS.p1, IDS.p2];
    let index = 0;
    const service = new BattleService(
      repository as never,
      {} as never,
      () =>
        ids[index++] ??
        (() => {
          throw new Error("id factory exhausted");
        })(),
    );

    const result = await service.initialize(IDS.battle, "PLAYER");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.firstTurnInitiative).toBe("PLAYER");
  });
});
