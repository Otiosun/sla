import type { WildPokemonSnapshot } from "../encounter/contracts.js";

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
      readonly pokemonInstanceId: string;
      readonly placement: {
        readonly placementKind: "TEAM" | "BOX";
        readonly boxNo: number | null;
        readonly slotNo: number;
      };
      readonly trainerName: string | null;
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
    readonly now: Date;
  }): Promise<CompetitiveSpawnClaimResult>;
  expireDue(now: Date, limit: number): Promise<number>;
}
