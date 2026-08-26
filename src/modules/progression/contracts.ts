import { z } from "zod";
import type { EvolutionTrigger } from "../pokemon/evolution.js";

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(512);

export const ApplyBattleRewardInputSchema = z
  .object({ battleId: uuid, idempotencyKey, correlationId: uuid })
  .strict();
export type ApplyBattleRewardInput = z.infer<typeof ApplyBattleRewardInputSchema>;

export const ResolveMoveChoiceInputSchema = z
  .object({
    choiceId: uuid,
    playerId: uuid,
    replaceSlotNo: z.number().int().min(1).max(4).nullable(),
    correlationId: uuid,
  })
  .strict();
export type ResolveMoveChoiceInput = z.infer<typeof ResolveMoveChoiceInputSchema>;

export const EvolvePokemonInputSchema = z
  .object({
    playerId: uuid,
    pokemonInstanceId: uuid,
    idempotencyKey,
    correlationId: uuid,
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("LEVEL") }).strict(),
      z.object({ kind: z.literal("ITEM"), itemId: uuid }).strict(),
    ]),
  })
  .strict();
export type EvolvePokemonInput = z.infer<typeof EvolvePokemonInputSchema>;

export interface PokemonXpAwardResult {
  readonly pokemonInstanceId: string;
  readonly offeredXp: number;
  readonly awardedXp: number;
  readonly discardedXp: number;
  readonly beforeLevel: number;
  readonly afterLevel: number;
  readonly beforeXp: number;
  readonly afterXp: number;
  readonly learnedMoveIds: readonly string[];
  readonly pendingMoveChoiceIds: readonly string[];
  readonly evolution: EvolutionResult | null;
}

export interface TrainerProgressResult {
  readonly playerId: string;
  readonly pointsGained: number;
  readonly beforePoints: number;
  readonly afterPoints: number;
  readonly beforeLevel: number;
  readonly afterLevel: number;
  readonly unlockKeys: readonly string[];
}

export interface BattleRewardResult {
  readonly battleId: string;
  readonly playerId: string;
  readonly pokemon: readonly PokemonXpAwardResult[];
  readonly trainer: TrainerProgressResult;
  readonly replayed: boolean;
}

export interface MoveChoiceResult {
  readonly choiceId: string;
  readonly pokemonInstanceId: string;
  readonly moveId: string;
  readonly status: "RESOLVED" | "SKIPPED";
  readonly replacedSlotNo: number | null;
  readonly replayed: boolean;
}

export interface EvolutionResult {
  readonly pokemonInstanceId: string;
  readonly fromFormId: string;
  readonly toFormId: string;
  readonly triggerKind: EvolutionTrigger["kind"];
  readonly beforeLevel: number;
  readonly afterLevel: number;
  readonly replayed: boolean;
}
