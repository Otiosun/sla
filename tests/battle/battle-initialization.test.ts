import { describe, expect, it } from "vitest";
import { initializeBattleState } from "../../src/modules/battle/initialization.js";
import type { BattleCombatant } from "../../src/modules/battle/contracts.js";
import type { BattlePokemonBuild, BattleRootRecord } from "../../src/modules/battle/ports.js";
import {
  IDS,
  battleState,
  playerCombatant,
  reserveCombatant,
  wildCombatant,
} from "./fixtures.js";

const secondPlayerId = "00000000-0000-4000-8000-000000000006";

function buildFromCombatant(combatant: BattleCombatant): BattlePokemonBuild {
  return {
    pokemonInstanceId: combatant.pokemonInstanceId,
    participantKind: combatant.participantKind,
    rosterPosition: combatant.rosterPosition,
    formId: combatant.formId,
    speciesId: combatant.speciesId,
    level: combatant.level,
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

function root(battleType: BattleRootRecord["battleType"]): BattleRootRecord {
  return {
    battleId: IDS.battle,
    battleType,
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

function idFactory(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test id factory exhausted");
    index += 1;
    return value;
  };
}

describe("shared Battle initialization", () => {
  it("reproduces the existing WILD version-0 state semantics", () => {
    const initialized = initializeBattleState({
      root: root("WILD"),
      sides: [
        {
          sideNo: 1,
          controllerKind: "PLAYER",
          playerId: IDS.player,
          party: [buildFromCombatant(playerCombatant())],
        },
        {
          sideNo: 2,
          controllerKind: "WILD",
          playerId: null,
          party: [buildFromCombatant(wildCombatant())],
        },
      ],
      idFactory: idFactory([IDS.p1, IDS.p2]),
    });

    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value).toEqual(battleState(false));
  });

  it("builds a PLAYER-vs-PLAYER version-0 state without a second engine", () => {
    const initialized = initializeBattleState({
      root: root("PVP"),
      sides: [
        {
          sideNo: 1,
          controllerKind: "PLAYER",
          playerId: IDS.player,
          party: [buildFromCombatant(playerCombatant())],
        },
        {
          sideNo: 2,
          controllerKind: "PLAYER",
          playerId: secondPlayerId,
          party: [buildFromCombatant(reserveCombatant())],
        },
      ],
      idFactory: idFactory([IDS.p1, IDS.p2]),
    });

    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value.battleType).toBe("PVP");
    expect(initialized.value.version).toBe(0);
    expect(initialized.value.status).toBe("ACTIVE");
    expect(initialized.value.sides).toEqual([
      expect.objectContaining({
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: IDS.player,
      }),
      expect.objectContaining({
        sideNo: 2,
        controllerKind: "PLAYER",
        playerId: secondPlayerId,
      }),
    ]);
    expect(initialized.value.combatants).toHaveLength(2);
    expect(initialized.value.combatants.every((entry) => entry.participantKind === "PLAYER_POKEMON"))
      .toBe(true);
  });
});
