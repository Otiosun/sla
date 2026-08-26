import type {
  BattleCombatant,
  BattleMoveSnapshot,
  BattleState,
} from "../../src/modules/battle/contracts.js";
import type { BattleRules } from "../../src/modules/battle/rules.js";
import { matchupKey } from "../../src/modules/battle/rules.js";

export const IDS = {
  battle: "00000000-0000-4000-8000-000000000001",
  encounter: "00000000-0000-4000-8000-000000000002",
  release: "00000000-0000-4000-8000-000000000003",
  ruleset: "00000000-0000-4000-8000-000000000004",
  player: "00000000-0000-4000-8000-000000000005",
  p1: "00000000-0000-4000-8000-000000000101",
  p1Reserve: "00000000-0000-4000-8000-000000000102",
  p2: "00000000-0000-4000-8000-000000000201",
  p1Instance: "00000000-0000-4000-8000-000000000301",
  p1ReserveInstance: "00000000-0000-4000-8000-000000000302",
  fire: "00000000-0000-4000-8000-000000000401",
  normal: "00000000-0000-4000-8000-000000000402",
  grass: "00000000-0000-4000-8000-000000000403",
  flying: "00000000-0000-4000-8000-000000000404",
  water: "00000000-0000-4000-8000-000000000405",
  electric: "00000000-0000-4000-8000-000000000406",
  ghost: "00000000-0000-4000-8000-000000000407",
  charmanderForm: "00000000-0000-4000-8000-000000000501",
  charmanderSpecies: "00000000-0000-4000-8000-000000000502",
  squirtleForm: "00000000-0000-4000-8000-000000000503",
  squirtleSpecies: "00000000-0000-4000-8000-000000000504",
  pidgeyForm: "00000000-0000-4000-8000-000000000505",
  pidgeySpecies: "00000000-0000-4000-8000-000000000506",
  tackle: "00000000-0000-4000-8000-000000000601",
  ember: "00000000-0000-4000-8000-000000000602",
  quickAttack: "00000000-0000-4000-8000-000000000603",
  growl: "00000000-0000-4000-8000-000000000604",
  gust: "00000000-0000-4000-8000-000000000605",
  blaze: "00000000-0000-4000-8000-000000000701",
  keenEye: "00000000-0000-4000-8000-000000000702",
  staticAbility: "00000000-0000-4000-8000-000000000703",
  runAway: "00000000-0000-4000-8000-000000000704",
  hardy: "00000000-0000-4000-8000-000000000801",
} as const;

const move = (input: Partial<BattleMoveSnapshot> & Pick<BattleMoveSnapshot, "slotNo" | "moveId">): BattleMoveSnapshot => ({
  slotNo: input.slotNo,
  moveId: input.moveId,
  typeId: input.typeId ?? IDS.normal,
  typeSlug: input.typeSlug ?? "normal",
  category: input.category ?? "PHYSICAL",
  power: input.power ?? 40,
  accuracy: input.accuracy ?? 100,
  priority: input.priority ?? 0,
  maxPp: input.maxPp ?? 35,
  ppCurrent: input.ppCurrent ?? 35,
  effectKey: input.effectKey ?? null,
  effectConfig: input.effectConfig ?? {},
  flags: input.flags ?? { makesContact: true },
});

export const TEST_RULES: BattleRules = {
  ivEnabled: true,
  evEnabled: false,
  natureEnabled: true,
  ppEnabled: true,
  accuracyEvasionEnabled: true,
  criticalMultiplierBasisPoints: 15_000,
  criticalChanceBasisPoints: 0,
  stabMultiplierBasisPoints: 15_000,
  damageRandomMinBasisPoints: 10_000,
  damageRandomMaxBasisPoints: 10_000,
  switchConsumesTurn: true,
  typeMultipliers: {
    [matchupKey(IDS.fire, IDS.grass)]: 20_000,
    [matchupKey(IDS.normal, IDS.ghost)]: 0,
  },
  status: {
    burnAttackMultiplierBasisPoints: 5_000,
    burnResidualDivisor: 16,
    poisonResidualDivisor: 8,
    paralysisSpeedMultiplierBasisPoints: 5_000,
    paralysisBlockChanceBasisPoints: 2_500,
    sleepMinTurns: 1,
    sleepMaxTurns: 3,
    freezeThawChanceBasisPoints: 2_000,
    confusionSelfHitChanceBasisPoints: 3_333,
  },
};

export function playerCombatant(): BattleCombatant {
  return {
    participantId: IDS.p1,
    sideNo: 1,
    rosterPosition: 1,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: IDS.p1Instance,
    formId: IDS.charmanderForm,
    speciesId: IDS.charmanderSpecies,
    level: 10,
    type1Id: IDS.fire,
    type1Slug: "fire",
    type2Id: null,
    type2Slug: null,
    baseStats: { hp: 39, attack: 52, defense: 43, spAttack: 60, spDefense: 50, speed: 65 },
    ivs: { hp: 15, attack: 15, defense: 15, spAttack: 15, spDefense: 15, speed: 15 },
    nature: { natureId: IDS.hardy, increasedStat: null, decreasedStat: null },
    ability: {
      abilityId: IDS.blaze,
      effectKey: "low-hp-type-boost",
      effectConfig: { typeSlug: "fire", multiplierBasisPoints: 15_000 },
    },
    moves: [
      move({ slotNo: 1, moveId: IDS.tackle }),
      move({
        slotNo: 2,
        moveId: IDS.ember,
        typeId: IDS.fire,
        typeSlug: "fire",
        category: "SPECIAL",
        maxPp: 25,
        ppCurrent: 25,
        flags: { makesContact: false },
        effectKey: "apply-status",
        effectConfig: { status: "BURN", chanceBasisPoints: 1_000 },
      }),
      move({ slotNo: 3, moveId: IDS.quickAttack, priority: 1, maxPp: 30, ppCurrent: 30 }),
      move({
        slotNo: 4,
        moveId: IDS.growl,
        category: "STATUS",
        power: null,
        maxPp: 40,
        ppCurrent: 40,
        flags: { makesContact: false },
        effectKey: "modify-stat-stage",
        effectConfig: { stat: "ATTACK", stages: -1 },
      }),
    ],
    maxHp: 29,
    currentHp: 29,
    majorStatus: null,
    stages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0, accuracy: 0, evasion: 0 },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

export function reserveCombatant(): BattleCombatant {
  const base = playerCombatant();
  return {
    ...base,
    participantId: IDS.p1Reserve,
    rosterPosition: 2,
    pokemonInstanceId: IDS.p1ReserveInstance,
    formId: IDS.squirtleForm,
    speciesId: IDS.squirtleSpecies,
    type1Id: IDS.water,
    type1Slug: "water",
    baseStats: { hp: 44, attack: 48, defense: 65, spAttack: 50, spDefense: 64, speed: 43 },
    maxHp: 31,
    currentHp: 31,
  };
}

export function wildCombatant(): BattleCombatant {
  return {
    participantId: IDS.p2,
    sideNo: 2,
    rosterPosition: 1,
    participantKind: "WILD_POKEMON",
    pokemonInstanceId: null,
    formId: IDS.pidgeyForm,
    speciesId: IDS.pidgeySpecies,
    level: 5,
    type1Id: IDS.normal,
    type1Slug: "normal",
    type2Id: IDS.flying,
    type2Slug: "flying",
    baseStats: { hp: 40, attack: 45, defense: 40, spAttack: 35, spDefense: 35, speed: 56 },
    ivs: { hp: 10, attack: 10, defense: 10, spAttack: 10, spDefense: 10, speed: 10 },
    nature: { natureId: IDS.hardy, increasedStat: null, decreasedStat: null },
    ability: { abilityId: IDS.keenEye, effectKey: "prevent-accuracy-drop", effectConfig: {} },
    moves: [
      move({ slotNo: 1, moveId: IDS.tackle }),
      move({
        slotNo: 2,
        moveId: IDS.gust,
        typeId: IDS.flying,
        typeSlug: "flying",
        category: "SPECIAL",
        maxPp: 35,
        ppCurrent: 35,
        flags: { makesContact: false },
      }),
    ],
    maxHp: 19,
    currentHp: 19,
    majorStatus: null,
    stages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0, accuracy: 0, evasion: 0 },
    volatile: { flinch: false, confusionTurns: 0 },
  };
}

export function battleState(withReserve = false): BattleState {
  const player = playerCombatant();
  const wild = wildCombatant();
  const reserve = withReserve ? reserveCombatant() : null;
  return {
    schemaVersion: 1,
    battleId: IDS.battle,
    battleType: "WILD",
    status: "ACTIVE",
    contentReleaseId: IDS.release,
    rulesetId: IDS.ruleset,
    encounterId: IDS.encounter,
    turnNumber: 0,
    version: 0,
    rngCounter: "0",
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: IDS.player,
        participantIds: reserve === null ? [player.participantId] : [player.participantId, reserve.participantId],
        activeParticipantId: player.participantId,
        result: null,
      },
      {
        sideNo: 2,
        controllerKind: "WILD",
        playerId: null,
        participantIds: [wild.participantId],
        activeParticipantId: wild.participantId,
        result: null,
      },
    ],
    combatants: reserve === null ? [player, wild] : [player, reserve, wild],
  };
}
