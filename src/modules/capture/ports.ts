import type { EncounterId, PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import type { EncryptedSeedEnvelope, SeedMaterial } from "../encounter/ports.js";
import type {
  CapturedPokemonState,
  CaptureAttemptRecord,
  CaptureContext,
  CaptureProbabilityBreakdown,
  CaptureRosterPlacement,
} from "./contracts.js";

export interface CaptureSeedProvider {
  create(context: string): SeedMaterial;
}

export interface CapturePendingWrite {
  readonly attemptId: string;
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly battleId: string | null;
  readonly ballItemId: string;
  readonly idempotencyStorageKey: string;
  readonly requestFingerprint: string;
  readonly sourceEncounterStatus: "ENGAGED" | "IN_BATTLE";
  readonly correlationId: string;
  readonly probabilityBasisPoints: number;
  readonly rollBasisPoints: number;
  readonly seed: EncryptedSeedEnvelope;
  readonly rngCounter: bigint;
  readonly breakdown: CaptureProbabilityBreakdown;
}

export interface CaptureResolutionBase {
  readonly attemptId: string;
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly sourceEncounterStatus: "ENGAGED" | "IN_BATTLE";
  readonly resolvingEncounterRevision: bigint;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly probabilityBasisPoints: number;
  readonly rollBasisPoints: number;
}

export interface CaptureFailureWrite extends CaptureResolutionBase {}

export interface CaptureSuccessWrite extends CaptureResolutionBase {
  readonly battleId: string | null;
  readonly expectedBattleVersion: number | null;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly placement: CaptureRosterPlacement;
  readonly captured: CapturedPokemonState;
  readonly encounterSnapshot: CaptureContext["encounterSnapshot"];
  readonly contentReleaseId: string;
  readonly rulesetId: string;
}

export type CaptureBallConsumeResult = "CONSUMED" | "INSUFFICIENT" | "CLAIM_CONFLICT";

export interface CaptureTransaction {
  findAttempt(idempotencyStorageKey: string): Promise<CaptureAttemptRecord | null>;
  loadContext(
    playerId: PlayerId,
    encounterId: EncounterId,
    ballItemId: string,
  ): Promise<CaptureContext | null>;
  beginResolving(input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly sourceStatus: "ENGAGED" | "IN_BATTLE";
    readonly expectedRevision: bigint;
  }): Promise<bigint | null>;
  insertPending(input: CapturePendingWrite): Promise<boolean>;
  consumeBall(input: {
    readonly attemptId: string;
    readonly playerId: PlayerId;
    readonly ballItemId: string;
    readonly idempotencyStorageKey: string;
    readonly correlationId: string;
  }): Promise<CaptureBallConsumeResult>;
  nextRosterPlacement(playerId: PlayerId): Promise<CaptureRosterPlacement>;
  resolveFailure(input: CaptureFailureWrite): Promise<void>;
  resolveSuccess(input: CaptureSuccessWrite): Promise<void>;
}

export interface CaptureRepository {
  transaction<T>(work: (transaction: CaptureTransaction) => Promise<T>): Promise<T>;
}
