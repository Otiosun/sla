import type { BattleCombatant, BattleStages, BattleStats } from "./contracts.js";
import type { BattleRules } from "./rules.js";

const BP = 10_000;

function natureBasisPoints(
  stat: "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED",
  combatant: BattleCombatant,
  rules: BattleRules,
): number {
  if (!rules.natureEnabled) return BP;
  if (combatant.nature.increasedStat === stat) return 11_000;
  if (combatant.nature.decreasedStat === stat) return 9_000;
  return BP;
}

function nonHpStat(base: number, iv: number, level: number, natureBp: number): number {
  const beforeNature = Math.floor(((2 * base + iv) * level) / 100) + 5;
  return Math.max(1, Math.floor((beforeNature * natureBp) / BP));
}

export function calculateDerivedStats(combatant: BattleCombatant, rules: BattleRules): BattleStats {
  const ivs = rules.ivEnabled
    ? combatant.ivs
    : { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  const level = combatant.level;
  return {
    hp: Math.floor(((2 * combatant.baseStats.hp + ivs.hp) * level) / 100) + level + 10,
    attack: nonHpStat(
      combatant.baseStats.attack,
      ivs.attack,
      level,
      natureBasisPoints("ATTACK", combatant, rules),
    ),
    defense: nonHpStat(
      combatant.baseStats.defense,
      ivs.defense,
      level,
      natureBasisPoints("DEFENSE", combatant, rules),
    ),
    spAttack: nonHpStat(
      combatant.baseStats.spAttack,
      ivs.spAttack,
      level,
      natureBasisPoints("SP_ATTACK", combatant, rules),
    ),
    spDefense: nonHpStat(
      combatant.baseStats.spDefense,
      ivs.spDefense,
      level,
      natureBasisPoints("SP_DEFENSE", combatant, rules),
    ),
    speed: nonHpStat(
      combatant.baseStats.speed,
      ivs.speed,
      level,
      natureBasisPoints("SPEED", combatant, rules),
    ),
  };
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
