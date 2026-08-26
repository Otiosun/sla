import { RulesetConfigSchema, type RulesetSnapshot } from "../catalog/contracts.js";
import type { BattleError, MajorStatusKey } from "./contracts.js";

export interface BattleRules {
  readonly ivEnabled: boolean;
  readonly evEnabled: boolean;
  readonly natureEnabled: boolean;
  readonly ppEnabled: boolean;
  readonly accuracyEvasionEnabled: boolean;
  readonly criticalMultiplierBasisPoints: number;
  readonly criticalChanceBasisPoints: number;
  readonly stabMultiplierBasisPoints: number;
  readonly damageRandomMinBasisPoints: number;
  readonly damageRandomMaxBasisPoints: number;
  readonly switchConsumesTurn: true;
  readonly typeMultipliers: Readonly<Record<string, number>>;
  readonly status: Readonly<{
    burnAttackMultiplierBasisPoints: number;
    burnResidualDivisor: number;
    poisonResidualDivisor: number;
    paralysisSpeedMultiplierBasisPoints: number;
    paralysisBlockChanceBasisPoints: number;
    sleepMinTurns: number;
    sleepMaxTurns: number;
    freezeThawChanceBasisPoints: number;
    confusionSelfHitChanceBasisPoints: number;
  }>;
}

export type BattleRulesResult =
  | { readonly ok: true; readonly value: BattleRules }
  | { readonly ok: false; readonly error: BattleError };

export function matchupKey(attackingTypeId: string, defendingTypeId: string): string {
  return `${attackingTypeId}:${defendingTypeId}`;
}

export function typeEffectivenessBasisPoints(
  rules: BattleRules,
  attackingTypeId: string,
  defendingTypeIds: readonly string[],
): number {
  let result = 10_000;
  for (const defendingTypeId of defendingTypeIds) {
    result = Math.floor(
      (result * (rules.typeMultipliers[matchupKey(attackingTypeId, defendingTypeId)] ?? 10_000)) /
        10_000,
    );
  }
  return result;
}

export function normalizeBattleRules(snapshot: RulesetSnapshot): BattleRulesResult {
  const parsed = RulesetConfigSchema.safeParse(snapshot.config);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "BATTLE_STATE_INVALID",
        message: "Pinned ruleset has invalid battle configuration",
        details: { issues: parsed.error.issues },
      },
    };
  }
  if (parsed.data.battle.switchConsumesTurn === false) {
    return {
      ok: false,
      error: {
        code: "BATTLE_STATE_INVALID",
        message: "Battle Engine v1 supports only switchConsumesTurn=true",
      },
    };
  }
  const minRandom = parsed.data.battle.damageRandomMinBasisPoints ?? 8_500;
  const maxRandom = parsed.data.battle.damageRandomMaxBasisPoints ?? 10_000;
  if (minRandom > maxRandom) {
    return {
      ok: false,
      error: {
        code: "BATTLE_STATE_INVALID",
        message: "Battle random damage range is inverted",
        details: { minRandom, maxRandom },
      },
    };
  }
  const typeMultipliers: Record<string, number> = {};
  for (const matchup of snapshot.typeMatchups) {
    typeMultipliers[matchupKey(matchup.attackingTypeId, matchup.defendingTypeId)] =
      matchup.multiplierBasisPoints;
  }
  return {
    ok: true,
    value: {
      ivEnabled: parsed.data.battle.ivEnabled,
      evEnabled: parsed.data.battle.evEnabled,
      natureEnabled: parsed.data.battle.natureEnabled,
      ppEnabled: parsed.data.battle.ppEnabled,
      accuracyEvasionEnabled: parsed.data.battle.accuracyEvasionEnabled,
      criticalMultiplierBasisPoints: parsed.data.battle.criticalMultiplierBasisPoints,
      criticalChanceBasisPoints: 417,
      stabMultiplierBasisPoints: parsed.data.battle.stabMultiplierBasisPoints ?? 15_000,
      damageRandomMinBasisPoints: minRandom,
      damageRandomMaxBasisPoints: maxRandom,
      switchConsumesTurn: true,
      typeMultipliers,
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
    },
  };
}

export function statusCounterOnApply(
  status: MajorStatusKey,
  randomInt: (maxExclusive: number) => number,
  rules: BattleRules,
): number | null {
  if (status !== "SLEEP") return null;
  const width = rules.status.sleepMaxTurns - rules.status.sleepMinTurns + 1;
  return rules.status.sleepMinTurns + randomInt(width);
}
