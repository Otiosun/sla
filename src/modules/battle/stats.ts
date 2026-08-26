import { calculatePokemonStats } from "../pokemon/stats.js";
import type { BattleCombatant, BattleStages, BattleStats } from "./contracts.js";
import type { BattleRules } from "./rules.js";

const BP = 10_000;

export function calculateDerivedStats(combatant: BattleCombatant, rules: BattleRules): BattleStats {
  return calculatePokemonStats({
    baseStats: combatant.baseStats,
    ivs: combatant.ivs,
    level: combatant.level,
    nature: combatant.nature,
    ivEnabled: rules.ivEnabled,
    natureEnabled: rules.natureEnabled,
  });
}

export function applyBattleStage(value: number, stage: number): number {
  if (stage >= 0) return Math.max(1, Math.floor((value * (2 + stage)) / 2));
  return Math.max(1, Math.floor((value * 2) / (2 - stage)));
}

export function accuracyStageRatio(stage: number): readonly [number, number] {
  return stage >= 0 ? [3 + stage, 3] : [3, 3 - stage];
}

export function effectiveAccuracyPercent(
  baseAccuracy: number,
  attackerStages: BattleStages,
  defenderStages: BattleStages,
  enabled: boolean,
): number {
  if (!enabled) return Math.max(0, Math.min(100, baseAccuracy));
  const [accuracyNum, accuracyDen] = accuracyStageRatio(attackerStages.accuracy);
  const [evasionNum, evasionDen] = accuracyStageRatio(defenderStages.evasion);
  const value = (baseAccuracy * accuracyNum * evasionDen) / (accuracyDen * evasionNum);
  return Math.max(0, Math.min(100, value));
}

export function effectiveSpeed(combatant: BattleCombatant, rules: BattleRules): number {
  let speed = applyBattleStage(
    calculateDerivedStats(combatant, rules).speed,
    combatant.stages.speed,
  );
  if (combatant.majorStatus?.key === "PARALYSIS") {
    speed = Math.max(
      1,
      Math.floor((speed * rules.status.paralysisSpeedMultiplierBasisPoints) / BP),
    );
  }
  return speed;
}

export function effectiveOffense(
  combatant: BattleCombatant,
  category: "PHYSICAL" | "SPECIAL",
  rules: BattleRules,
): number {
  const stats = calculateDerivedStats(combatant, rules);
  if (category === "SPECIAL") return applyBattleStage(stats.spAttack, combatant.stages.spAttack);
  let attack = applyBattleStage(stats.attack, combatant.stages.attack);
  if (combatant.majorStatus?.key === "BURN") {
    attack = Math.max(1, Math.floor((attack * rules.status.burnAttackMultiplierBasisPoints) / BP));
  }
  return attack;
}

export function effectiveDefense(
  combatant: BattleCombatant,
  category: "PHYSICAL" | "SPECIAL",
  rules: BattleRules,
): number {
  const stats = calculateDerivedStats(combatant, rules);
  return category === "SPECIAL"
    ? applyBattleStage(stats.spDefense, combatant.stages.spDefense)
    : applyBattleStage(stats.defense, combatant.stages.defense);
}
