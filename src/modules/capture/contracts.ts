import { z } from "zod";
import type { BattleMajorStatus, BattleState } from "../battle/contracts.js";
import type { WildPokemonSnapshot } from "../encounter/contracts.js";
import type {
  CorrelationId,
  EncounterId,
  PlayerId,
  PokemonInstanceId,
} from "../../shared-kernel/ids.js";

const uuid = z.string().uuid();
const basisPoints = z.number().int().min(1).max(100_000);

export const CaptureSourceStatusSchema = z.enum(["ENGAGED", "IN_BATTLE"]);
export type CaptureSourceStatus = z.infer<typeof CaptureSourceStatusSchema>;

export const CaptureAttemptStatusSchema = z.enum(["PENDING", "FAILED", "CAPTURED"]);
export type CaptureAttemptStatus = z.infer<typeof CaptureAttemptStatusSchema>;

export const CaptureProbabilityInputSchema = z
  .object({
    catchRate: z.number().int().min(0).max(255),
    currentHp: z.number().int().positive().max(999_999),
    maxHp: z.number().int().positive().max(999_999),
    ballMultiplierBasisPoints: basisPoints,
    status: z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]).nullable(),
    explicitModifierBasisPoints: z.array(basisPoints).max(16),
    ruleset: z
      .object({
        model: z.literal("POKEMON_INSPIRED_V1"),
        maxProbabilityBasisPoints: z.number().int().min(1).max(10_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.currentHp > value.maxHp) {
      context.addIssue({
        code: "custom",
        path: ["currentHp"],
        message: "currentHp cannot exceed maxHp",
      });
    }
  });
export type CaptureProbabilityInput = z.infer<typeof CaptureProbabilityInputSchema>;

export interface CaptureProbabilityBreakdown {
  readonly model: "POKEMON_INSPIRED_V1";
  readonly catchRate: number;
  readonly catchRateBasisPoints: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly hpFactorBasisPoints: number;
  readonly ballMultiplierBasisPoints: number;
  readonly status: BattleMajorStatus["key"] | null;
  readonly statusMultiplierBasisPoints: number;
  readonly explicitModifierBasisPoints: readonly number[];
  readonly rawProbabilityBasisPoints: number;
  readonly maxProbabilityBasisPoints: number;
  readonly finalProbabilityBasisPoints: number;
}

export interface CaptureProbabilityResult {
  readonly probabilityBasisPoints: number;
  readonly breakdown: CaptureProbabilityBreakdown;
}

export interface CaptureAttemptInput {
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly expectedEncounterRevision: bigint;
  readonly expectedBattleVersion: number | null;
  readonly ballItemId: string;
  readonly idempotencyKey: string;
  readonly correlationId: CorrelationId;
  readonly causationId: string | null;
}

export interface CaptureRosterPlacement {
  readonly placementKind: "TEAM" | "BOX";
  readonly boxNo: number | null;
  readonly slotNo: number;
}

export interface CapturedPokemonState {
  readonly currentHp: number;
  readonly majorStatus: BattleMajorStatus["key"] | null;
  readonly moves: readonly {
    readonly moveId: string;
    readonly ppCurrent: number;
  }[];
}

export interface CaptureDomainEvent {
  readonly type: "CaptureAttemptResolved" | "PokemonCaptured";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CaptureAttemptResult {
  readonly captureAttemptId: string;
  readonly encounterId: EncounterId;
  readonly battleId: string | null;
  readonly status: "FAILED" | "CAPTURED";
  readonly probabilityBasisPoints: number;
  readonly rollBasisPoints: number;
  readonly pokemonInstanceId: PokemonInstanceId | null;
  readonly placement: CaptureRosterPlacement | null;
  readonly events: readonly CaptureDomainEvent[];
  readonly replayed: boolean;
}

export interface CaptureAttemptRecord {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly battleId: string | null;
  readonly ballItemId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly sourceEncounterStatus: CaptureSourceStatus;
  readonly correlationId: string;
  readonly status: CaptureAttemptStatus;
  readonly probabilityBasisPoints: number;
  readonly rollBasisPoints: number;
  readonly pokemonInstanceId: PokemonInstanceId | null;
  readonly placement: CaptureRosterPlacement | null;
  readonly breakdown: CaptureProbabilityBreakdown;
  readonly resolvedAt: Date | null;
}

export interface CaptureItemPolicy {
  readonly itemId: string;
  readonly itemKind: string;
  readonly effectKey: string | null;
  readonly effectConfig: unknown;
}

export interface CaptureContext {
  readonly playerId: PlayerId;
  readonly playerActive: boolean;
  readonly onboardingComplete: boolean;
  readonly encounterId: EncounterId;
  readonly encounterRevision: bigint;
  readonly sourceStatus: CaptureSourceStatus;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly rulesetConfig: unknown;
  readonly catchRate: number;
  readonly encounterSnapshot: WildPokemonSnapshot;
  readonly battleId: string | null;
  readonly battleState: BattleState | null;
  readonly ball: CaptureItemPolicy;
  readonly explicitModifierBasisPoints: readonly number[];
}

export const CaptureAttemptInputBoundarySchema = z
  .object({
    playerId: uuid,
    encounterId: uuid,
    expectedEncounterRevision: z.bigint().nonnegative(),
    expectedBattleVersion: z.number().int().nonnegative().safe().nullable(),
    ballItemId: uuid,
    idempotencyKey: z.string().trim().min(1).max(255),
    correlationId: uuid,
    causationId: uuid.nullable(),
  })
  .strict();
