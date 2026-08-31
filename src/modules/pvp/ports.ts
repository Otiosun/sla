import type { EncryptedSeedEnvelope } from "../encounter/ports.js";
import type { PvpChallenge } from "./challenge.js";

export interface InsertAcceptedPvpEncounterInput {
  readonly challenge: PvpChallenge;
  readonly seed: EncryptedSeedEnvelope;
}

export interface ReplacePvpChallengeInput {
  readonly expectedRevision: number;
  readonly next: PvpChallenge;
}

export interface PvpChallengeTransaction {
  challengeById(challengeId: string, lock?: boolean): Promise<PvpChallenge | null>;
  challengeByCreationKey(
    challengerPlayerId: string,
    creationIdempotencyKey: string,
    lock?: boolean,
  ): Promise<PvpChallenge | null>;
  insertChallenge(challenge: PvpChallenge): Promise<boolean>;
  replaceChallenge(input: ReplacePvpChallengeInput): Promise<boolean>;
  insertAcceptedEncounter(input: InsertAcceptedPvpEncounterInput): Promise<void>;
}

export interface PvpChallengeRepository {
  transaction<T>(work: (transaction: PvpChallengeTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: PvpChallengeTransaction) => Promise<T>): Promise<T>;
}
