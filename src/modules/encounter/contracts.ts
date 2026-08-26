import { z } from "zod";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";
import type { EncounterConditions } from "../catalog/encounter-contracts.js";

export const EncounterStatusSchema = z.enum([
  "CREATED",
  "PRESENTED",
  "ENGAGED",
  "CAPTURE_RESOLVING",
  "IN_BATTLE",
  "CAPTURED",
  "FLED",
  "EXPIRED",
  "CLOSED",
]);
export type EncounterStatus = z.infer<typeof EncounterStatusSchema>;

export const CaptureStartStatusSchema = z.enum(["ENGAGED", "IN_BATTLE"]);
export type CaptureStartStatus = z.infer<typeof CaptureStartStatusSchema>;

export interface EncounterRulesetPolicy {
  readonly expirationSeconds: number;
  readonly captureAllowedStates: readonly CaptureStartStatus[];
}

export interface EncounterIvSet {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spAttack: number;
  readonly spDefense: number;
  readonly speed: number;
}

export interface EncounterBaseStats {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spAttack: number;
  readonly spDefense: number;
  readonly speed: number;
}

export interface WildMoveSnapshot {
  readonly moveId: string;
  readonly ppCurrent: number;
}

export interface WildPokemonSnapshot {
  readonly schemaVersion: 1;
  readonly formId: string;
  readonly speciesId: string;
  readonly level: number;
  readonly type1Id: string;
  readonly type2Id: string | null;
  readonly baseStats: EncounterBaseStats;
  readonly ivs: EncounterIvSet;
  readonly natureId: string;
  readonly abilityId: string;
  readonly moves: readonly WildMoveSnapshot[];
  readonly maxHp: number;
  readonly currentHp: number;
  readonly shiny: false;
  readonly gender: null;
}

export interface EncounterRecord {
  readonly encounterId: EncounterId;
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly status: EncounterStatus;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly creationIdempotencyKey: string;
  readonly rngCounter: bigint;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
  readonly closedAt: Date | null;
}

export interface EncounterView extends EncounterRecord {
  readonly snapshot: WildPokemonSnapshot;
  readonly battleId: string | null;
}

export interface EncounterPlayerContext {
  readonly playerActive: boolean;
  readonly onboardingComplete: boolean;
  readonly areaId: string | null;
  readonly activeBattle: boolean;
  readonly unlockKeys: readonly string[];
}

export interface EncounterTableEntryRecord {
  readonly entryId: string;
  readonly formId: string;
  readonly weight: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly active: boolean;
  readonly conditions: EncounterConditions;
}

export interface EncounterTableRecord {
  readonly encounterTableId: string;
  readonly slug: string;
  readonly active: boolean;
  readonly conditions: EncounterConditions;
  readonly entries: readonly EncounterTableEntryRecord[];
}

export interface WildBuildMove {
  readonly moveId: string;
  readonly learnMethod: string;
  readonly learnLevel: number | null;
  readonly maxPp: number;
}

export interface WildPokemonBuild {
  readonly formId: string;
  readonly speciesId: string;
  readonly type1Id: string;
  readonly type2Id: string | null;
  readonly baseStats: EncounterBaseStats;
  readonly abilityIds: readonly string[];
  readonly natureIds: readonly string[];
  readonly moves: readonly WildBuildMove[];
}

export interface CreateEncounterInput {
  readonly playerId: PlayerId;
  readonly idempotencyKey: string;
  readonly encounterTableSlug?: string;
}

export interface EncounterMutationInput {
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly expectedRevision: bigint;
}

export interface StartBattleResult {
  readonly encounter: EncounterView;
  readonly battleId: string;
  readonly replayed: boolean;
}

export interface ExpireResult {
  readonly expiredEncounterIds: readonly EncounterId[];
}
