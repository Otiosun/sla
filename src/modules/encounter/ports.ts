import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";
import type {
  EncounterPlayerContext,
  EncounterRecord,
  EncounterStatus,
  EncounterTableRecord,
  WildPokemonBuild,
  WildPokemonSnapshot,
} from "./contracts.js";

export interface EncryptedSeedEnvelope {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface SeedMaterial {
  readonly seed: Uint8Array;
  readonly envelope: EncryptedSeedEnvelope;
}

export interface EncounterSeedProvider {
  create(context: string): SeedMaterial;
}

export interface ActiveEncounterContent {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly rulesetConfig: unknown;
}

export interface EncounterTransaction {
  activeContent(): Promise<ActiveEncounterContent | null>;
  rulesetConfig(rulesetId: string): Promise<unknown | null>;
  playerContext(playerId: PlayerId, lock?: boolean): Promise<EncounterPlayerContext | null>;
  byCreationKey(
    playerId: PlayerId,
    creationIdempotencyKey: string,
    lock?: boolean,
  ): Promise<EncounterRecord | null>;
  activeForPlayer(playerId: PlayerId, lock?: boolean): Promise<EncounterRecord | null>;
  byId(
    playerId: PlayerId,
    encounterId: EncounterId,
    lock?: boolean,
  ): Promise<EncounterRecord | null>;
  snapshot(encounterId: EncounterId): Promise<WildPokemonSnapshot | null>;
  battleId(encounterId: EncounterId): Promise<string | null>;
  tables(contentReleaseId: string, areaId: string): Promise<readonly EncounterTableRecord[]>;
  wildBuild(contentReleaseId: string, formId: string): Promise<WildPokemonBuild | null>;
  insertEncounter(input: {
    readonly encounterId: EncounterId;
    readonly playerId: PlayerId;
    readonly areaId: string;
    readonly contentReleaseId: string;
    readonly rulesetId: string;
    readonly creationIdempotencyKey: string;
    readonly seed: EncryptedSeedEnvelope;
    readonly rngCounter: bigint;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly snapshot: WildPokemonSnapshot;
  }): Promise<EncounterRecord>;
  transition(input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly fromStatus: EncounterStatus;
    readonly toStatus: EncounterStatus;
    readonly expectedRevision: bigint;
    readonly closedAt: Date | null;
  }): Promise<EncounterRecord | null>;
  createBattle(input: {
    readonly battleId: string;
    readonly encounter: EncounterRecord;
    readonly seed: EncryptedSeedEnvelope;
  }): Promise<string>;
  expireDue(now: Date, limit: number): Promise<readonly EncounterId[]>;
}

export interface EncounterRepository {
  transaction<T>(work: (transaction: EncounterTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: EncounterTransaction) => Promise<T>): Promise<T>;
}
