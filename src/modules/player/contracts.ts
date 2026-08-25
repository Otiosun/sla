import { z } from "zod";
import type { CorrelationId, PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";

export const OnboardingStateSchema = z.enum([
  "NEW",
  "PROFILE_CREATED",
  "REGION_SELECTED",
  "STARTER_PENDING",
  "STARTER_GRANTED",
  "COMPLETE",
]);
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const ExternalIdentitySchema = z
  .object({
    provider: z.string().trim().min(1).max(32).regex(/^[a-z0-9][a-z0-9_-]*$/),
    externalId: z.string().trim().min(1).max(255),
  })
  .strict();
export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

export const ProfileInputSchema = z
  .object({
    trainerName: z.string().trim().min(1).max(40),
    locale: z.string().trim().min(2).max(32).nullable().optional(),
    metadata: z.object({}).strict().default({}),
  })
  .strict();
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const RegionSelectionSchema = z
  .object({
    regionId: z.string().uuid(),
  })
  .strict();
export type RegionSelection = z.infer<typeof RegionSelectionSchema>;

export const StarterSelectionSchema = z
  .object({
    formId: z.string().uuid(),
  })
  .strict();
export type StarterSelection = z.infer<typeof StarterSelectionSchema>;

export interface ContentContext {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
}

export interface OnboardingRecord extends ContentContext {
  readonly playerId: PlayerId;
  readonly playerStatus: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly state: OnboardingState;
  readonly starterClaimKey: string | null;
  readonly completedAt: Date | null;
  readonly revision: bigint;
  readonly originRegionId: string | null;
}

export interface StarterOption {
  readonly formId: string;
  readonly displayName: string;
  readonly starterLevel: number;
  readonly sortOrder: number;
}

export interface StarterMoveCandidate {
  readonly moveId: string;
  readonly maxPp: number;
  readonly learnMethod: "START" | "LEVEL";
  readonly learnLevel: number | null;
}

export interface StarterBuild {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly regionId: string;
  readonly formId: string;
  readonly starterLevel: number;
  readonly baseHp: number;
  readonly abilityIds: readonly string[];
  readonly natureIds: readonly string[];
  readonly moves: readonly StarterMoveCandidate[];
}

export interface GeneratedStarter {
  readonly level: number;
  readonly currentHp: number;
  readonly abilityId: string;
  readonly natureId: string;
  readonly ivs: {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly spAttack: number;
    readonly spDefense: number;
    readonly speed: number;
  };
  readonly moves: readonly {
    readonly moveId: string;
    readonly ppCurrent: number;
  }[];
}

export interface RosterPlacement {
  readonly placementKind: "TEAM" | "BOX";
  readonly boxNo: number | null;
  readonly slotNo: number;
}

export interface StarterGrantRecord {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly formId: string | null;
  readonly idempotencyKey: string;
}

export interface StarterGrantWrite extends ContentContext {
  readonly grantId: string;
  readonly historyEventId: string;
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly regionId: string;
  readonly formId: string;
  readonly idempotencyKey: string;
  readonly correlationId: CorrelationId | null;
  readonly generated: GeneratedStarter;
  readonly placement: RosterPlacement;
  readonly expectedOnboardingRevision: bigint;
}

export interface PlayerProfileView {
  readonly playerId: PlayerId;
  readonly playerStatus: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly trainerName: string | null;
  readonly originRegionId: string | null;
  readonly locale: string | null;
  readonly trainerLevel: number;
  readonly progressionPoints: bigint;
  readonly onboardingState: OnboardingState;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly starterPokemonInstanceId: PokemonInstanceId | null;
  readonly team: readonly {
    readonly pokemonInstanceId: PokemonInstanceId;
    readonly formId: string;
    readonly level: number;
    readonly currentHp: number;
    readonly slotNo: number;
  }[];
}

export interface ResolvePlayerResult {
  readonly playerId: PlayerId;
  readonly state: OnboardingState;
  readonly created: boolean;
}

export interface StarterPreparationResult {
  readonly playerId: PlayerId;
  readonly starterClaimKey: string;
  readonly options: readonly StarterOption[];
}

export interface StarterGrantResult {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly state: "STARTER_GRANTED" | "COMPLETE";
  readonly replayed: boolean;
}
