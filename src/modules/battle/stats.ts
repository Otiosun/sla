import { EffectConfigSchemas } from "../catalog/contracts.js";
import { calculatePokemonStats } from "../pokemon/stats.js";
import type { BattleCombatant, BattleStages, BattleStats } from "./contracts.js";
import type { BattleRules } from "./rules.js";

const BP = 10_000;

function activeStatMultiplier(
  combatant: BattleCombatant,
  stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED",
): { readonly multiplierBasisPoints: number; readonly ignoreBurnAttackPenalty: boolean } | null {
  if (combatant.ability.effectKey !== "battle-stat-multiplier") return null;
  const parsed = EffectConfigSchemas["battle-stat-multiplier"].safeParse(
    combatant.ability.effectConfig,
  );
  if (!parsed.success || parsed.data.stat !== stat) return null;
  if (parsed.data.condition === "MAJOR_STATUS" && combatant.majorStatus === null) return null;
  return {
    multiplierBasisPoints: parsed.data.multiplierBasisPoints,
    ignoreBurnAttackPenalty: parsed.data.ignoreBurnAttackPenalty,
  };
}

function applyStatAbility(
  combatant: BattleCombatant,
  stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED",
  value: number,
): { readonly value: number; readonly ignoreBurnAttackPenalty: boolean } {
  const effect = activeStatMultiplier(combatant, stat);
  if (effect === null) return { value, ignoreBurnAttackPenalty: false };
  return {
    value: Math.max(1, Math.floor((value * effect.multiplierBasisPoints) / BP)),
    ignoreBurnAttackPenalty: effect.ignoreBurnAttackPenalty,
  };
}

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
  speed = applyStatAbility(combatant, "SPEED", speed).value;
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
  if (category === "SPECIAL") {
    const spAttack = applyBattleStage(stats.spAttack, combatant.stages.spAttack);
    return applyStatAbility(combatant, "SP_ATTACK", spAttack).value;
  }
  let attack = applyBattleStage(stats.attack, combatant.stages.attack);
  const ability = applyStatAbility(combatant, "ATTACK", attack);
  attack = ability.value;
  if (combatant.majorStatus?.key === "BURN" && !ability.ignoreBurnAttackPenalty) {
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
  if (category === "SPECIAL") {
    const spDefense = applyBattleStage(stats.spDefense, combatant.stages.spDefense);
    return applyStatAbility(combatant, "SP_DEFENSE", spDefense).value;
  }
  const defense = applyBattleStage(stats.defense, combatant.stages.defense);
  return applyStatAbility(combatant, "DEFENSE", defense).value;
}
