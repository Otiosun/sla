import { EffectConfigSchemas } from "../catalog/contracts.js";
import type { RandomSource } from "../../platform/rng/index.js";
import type { BattleCombatant, BattleMoveSnapshot } from "./contracts.js";
import type { BattleRules } from "./rules.js";
import { typeEffectivenessBasisPoints } from "./rules.js";
import { effectiveDefense, effectiveOffense } from "./stats.js";

const BP = 10_000;

export interface DamageResult {
  readonly damage: number;
  readonly critical: boolean;
  readonly effectivenessBasisPoints: number;
  readonly stabApplied: boolean;
  readonly randomBasisPoints: number;
  readonly abilityMultiplierBasisPoints: number;
}

function multiplyBasisPoints(value: number, multiplier: number): number {
  return Math.floor((value * multiplier) / BP);
}

function abilityDamageMultiplier(
  attacker: BattleCombatant,
  move: BattleMoveSnapshot,
): number {
  if (attacker.ability.effectKey !== "low-hp-type-boost") return BP;
  const parsed = EffectConfigSchemas["low-hp-type-boost"].safeParse(attacker.ability.effectConfig);
  if (!parsed.success) return BP;
  if (attacker.currentHp * 3 > attacker.maxHp) return BP;
  return parsed.data.typeSlug === move.typeSlug ? parsed.data.multiplierBasisPoints : BP;
}

export function computeDamage(
  attacker: BattleCombatant,
  defender: BattleCombatant,
  move: BattleMoveSnapshot,
  rules: BattleRules,
  rng: RandomSource,
): DamageResult {
  if (move.category === "STATUS" || move.power === null || move.power <= 0) {
    return {
      damage: 0,
      critical: false,
      effectivenessBasisPoints: 10_000,
      stabApplied: false,
      randomBasisPoints: 10_000,
      abilityMultiplierBasisPoints: 10_000,
    };
  }

  const defendingTypes = [defender.type1Id, ...(defender.type2Id === null ? [] : [defender.type2Id])];
  const effectivenessBasisPoints = typeEffectivenessBasisPoints(
    rules,
    move.typeId,
    defendingTypes,
  );
  if (effectivenessBasisPoints === 0) {
    return {
      damage: 0,
      critical: false,
      effectivenessBasisPoints,
      stabApplied: attacker.type1Id === move.typeId || attacker.type2Id === move.typeId,
      randomBasisPoints: 10_000,
      abilityMultiplierBasisPoints: abilityDamageMultiplier(attacker, move),
    };
  }

  const offense = effectiveOffense(attacker, move.category, rules);
  const defense = Math.max(1, effectiveDefense(defender, move.category, rules));
  const levelFactor = Math.floor((2 * attacker.level) / 5) + 2;
  let damage = Math.floor(Math.floor((levelFactor * move.power * offense) / defense) / 50) + 2;

  const stabApplied = attacker.type1Id === move.typeId || attacker.type2Id === move.typeId;
  if (stabApplied) damage = multiplyBasisPoints(damage, rules.stabMultiplierBasisPoints);
  damage = multiplyBasisPoints(damage, effectivenessBasisPoints);

  const critical = rng.randomInt(BP) < rules.criticalChanceBasisPoints;
  if (critical) damage = multiplyBasisPoints(damage, rules.criticalMultiplierBasisPoints);

  const abilityMultiplierBasisPoints = abilityDamageMultiplier(attacker, move);
  damage = multiplyBasisPoints(damage, abilityMultiplierBasisPoints);

  const width = rules.damageRandomMaxBasisPoints - rules.damageRandomMinBasisPoints + 1;
  const randomBasisPoints = rules.damageRandomMinBasisPoints + rng.randomInt(width);
  damage = multiplyBasisPoints(damage, randomBasisPoints);

  return {
    damage: Math.max(1, damage),
    critical,
    effectivenessBasisPoints,
    stabApplied,
    randomBasisPoints,
    abilityMultiplierBasisPoints,
  };
}
