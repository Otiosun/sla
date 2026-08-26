import {
  ApplyBattleRewardInputSchema,
  EvolvePokemonInputSchema,
  ResolveMoveChoiceInputSchema,
  type BattleRewardResult,
  type EvolutionResult,
  type MoveChoiceResult,
} from "./contracts.js";
import { progressionFailure, type ProgressionResult } from "./errors.js";
import type { ProgressionRepository } from "./ports.js";

export class ProgressionService {
  public constructor(private readonly repository: ProgressionRepository) {}

  public async applyBattleReward(input: unknown): Promise<ProgressionResult<BattleRewardResult>> {
    const parsed = ApplyBattleRewardInputSchema.safeParse(input);
    if (!parsed.success) return progressionFailure("PROGRESSION_INPUT_INVALID", "Invalid battle reward request");
    const persisted = await this.repository.applyBattleReward(parsed.data);
    switch (persisted.kind) {
      case "APPLIED":
        return { ok: true, value: persisted.result };
      case "REPLAYED":
        return { ok: true, value: { ...persisted.result, replayed: true } };
      case "NOT_FOUND":
        return progressionFailure("BATTLE_NOT_FOUND", "Battle was not found");
      case "NOT_ELIGIBLE":
        return progressionFailure("BATTLE_REWARD_NOT_ELIGIBLE", "Battle does not grant rewards", {
          status: persisted.status,
        });
      case "UNSUPPORTED":
        return progressionFailure("BATTLE_REWARD_UNSUPPORTED", persisted.reason);
      case "RULES_MISSING":
        return progressionFailure("PROGRESSION_RULES_MISSING", "Pinned ruleset has no progression policy");
      case "STATE_INVALID":
        return progressionFailure("PROGRESSION_STATE_INVALID", persisted.reason);
      case "IDEMPOTENCY_CONFLICT":
        return progressionFailure(
          "PROGRESSION_IDEMPOTENCY_CONFLICT",
          "Idempotency key is already bound to another reward",
        );
    }
  }

  public async resolveMoveChoice(input: unknown): Promise<ProgressionResult<MoveChoiceResult>> {
    const parsed = ResolveMoveChoiceInputSchema.safeParse(input);
    if (!parsed.success) return progressionFailure("PROGRESSION_INPUT_INVALID", "Invalid move choice request");
    const persisted = await this.repository.resolveMoveChoice(parsed.data);
    switch (persisted.kind) {
      case "RESOLVED":
      case "REPLAYED":
        return { ok: true, value: persisted.result };
      case "NOT_FOUND":
        return progressionFailure("MOVE_CHOICE_NOT_FOUND", "Pending move choice was not found");
      case "CONFLICT":
        return progressionFailure("MOVE_CHOICE_CONFLICT", persisted.reason);
    }
  }

  public async evolvePokemon(input: unknown): Promise<ProgressionResult<EvolutionResult>> {
    const parsed = EvolvePokemonInputSchema.safeParse(input);
    if (!parsed.success) return progressionFailure("PROGRESSION_INPUT_INVALID", "Invalid evolution request");
    const persisted = await this.repository.evolvePokemon(parsed.data);
    switch (persisted.kind) {
      case "EVOLVED":
      case "REPLAYED":
        return { ok: true, value: persisted.result };
      case "NOT_FOUND":
        return progressionFailure("EVOLUTION_NOT_FOUND", "Pokemon was not found");
      case "NOT_ELIGIBLE":
        return progressionFailure("EVOLUTION_NOT_ELIGIBLE", persisted.reason);
      case "ITEM_MISSING":
        return progressionFailure("EVOLUTION_ITEM_MISSING", "Required evolution item is unavailable");
      case "RULES_MISSING":
        return progressionFailure("PROGRESSION_RULES_MISSING", "Active ruleset has no progression policy");
      case "IDEMPOTENCY_CONFLICT":
        return progressionFailure(
          "PROGRESSION_IDEMPOTENCY_CONFLICT",
          "Idempotency key is already bound to another evolution",
        );
    }
  }
}
