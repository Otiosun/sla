import type { WildPokemonSnapshot } from "../encounter/contracts.js";
import type { CompetitiveSpawnRewardDescriptor } from "./reward.js";

export type CompetitiveSpawnStatus = "OPEN" | "WON" | "EXPIRED" | "CANCELLED";
export type CompetitiveSpawnTimeBucket = "MORNING" | "DAY" | "EVENING" | "NIGHT";

export interface CompetitiveSpawnRenderSpec {
  readonly schemaVersion: 1;
  readonly backgroundUrl: string;
  readonly spriteUrl: string;
  readonly fallbackSpriteUrl: string;
  readonly centerX: number;
  readonly groundY: number;
  readonly maxSize: number;
  readonly floatY: number;
  readonly shadowOpacity: number;
  readonly timeBucket: CompetitiveSpawnTimeBucket;
}

export interface CompetitiveSpawnCandidate {
  readonly formId: string;
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly speciesSlug: string;
  readonly displayName: string;
  /** Canonical pokemon_types.slug values. Runtime Postgres candidates always populate them. */
  readonly type1Slug?: string;
  readonly type2Slug?: string | null;
  readonly weight: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly areaId: string | null;
}

export interface CompetitiveSpawnCandidateContext {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly playerAreaId: string | null;
  readonly localCandidates: readonly CompetitiveSpawnCandidate[];
  readonly globalCandidates: readonly CompetitiveSpawnCandidate[];
}

export interface CompetitiveSpawnRecord {
  readonly id: string;
  readonly communityGroupId: string;
  readonly provider: string;
  readonly chatRef: string;
  readonly status: CompetitiveSpawnStatus;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly areaId: string | null;
  readonly formId: string;
  readonly speciesId: string;
  readonly speciesDisplayName: string;
  readonly normalizedAnswers: readonly string[];
  readonly nationalDex: number;
  readonly level: number;
  readonly shiny: boolean;
  readonly snapshot: WildPokemonSnapshot;
  readonly renderSpec: CompetitiveSpawnRenderSpec;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly winnerPlayerId: string | null;
}

export interface CompetitiveSpawnOpenWrite {
  readonly id: string;
  readonly communityGroupId: string;
  readonly provider: string;
  readonly chatRef: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly areaId: string | null;
  readonly formId: string;
  readonly speciesId: string;
  readonly speciesDisplayName: string;
  readonly normalizedAnswers: readonly string[];
  readonly nationalDex: number;
  readonly level: number;
  readonly shiny: boolean;
  readonly snapshot: WildPokemonSnapshot;
  readonly renderSpec: CompetitiveSpawnRenderSpec;
  readonly creationIdempotencyKey: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

export type CompetitiveSpawnClaimResult =
  | {
      readonly kind: "WON";
      readonly spawn: CompetitiveSpawnRecord;
      readonly pokemonInstanceId: string | null;
      readonly placement: {
        readonly placementKind: "TEAM" | "BOX";
        readonly boxNo: number | null;
        readonly slotNo: number;
      } | null;
      readonly trainerName: string | null;
      readonly reward: CompetitiveSpawnRewardDescriptor;
      readonly pokemonBonus: boolean;
    }
  | { readonly kind: "CLOSED" }
  | { readonly kind: "REPLAYED" }
  | { readonly kind: "PLAYER_INELIGIBLE" };

export interface CompetitiveSpawnRepository {
  activeForGroup(groupId: string): Promise<CompetitiveSpawnRecord | null>;
  canOpen(groupId: string, now: Date, cooldownMs: number): Promise<boolean>;
  candidateContext(playerId: string | null): Promise<CompetitiveSpawnCandidateContext | null>;
  createOpen(
    input: CompetitiveSpawnOpenWrite,
    cooldownMs: number,
  ): Promise<CompetitiveSpawnRecord | null>;
  consumeGuessBudget(input: {
    readonly spawnId: string;
    readonly playerId: string;
    readonly now: Date;
    readonly minIntervalMs: number;
    readonly maxAttempts: number;
  }): Promise<boolean>;
  recordWrongGuess(input: {
    readonly spawnId: string;
    readonly inboxMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly normalizedGuess: string;
  }): Promise<void>;
  claimCorrect(input: {
    readonly spawnId: string;
    readonly inboxMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly normalizedGuess: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly rewardKindRoll: number;
    readonly rewardAmountRoll: number;
    readonly rewardItemRoll: number;
    readonly pokemonBonusRoll: number;
    readonly now: Date;
  }): Promise<CompetitiveSpawnClaimResult>;
  reconcilePublication(input: {
    readonly now: Date;
    readonly ttlMs: number;
    readonly orphanGraceMs: number;
    readonly limit: number;
  }): Promise<{ readonly published: number; readonly cancelled: number }>;
  expireDue(now: Date, limit: number): Promise<number>;
}
