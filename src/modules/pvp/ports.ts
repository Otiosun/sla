import type { Result } from "../../shared-kernel/result.js";
import type { EncryptedSeedEnvelope } from "../encounter/ports.js";
import type { PvpChallenge } from "./challenge.js";

export interface PvpPlayerContext {
  readonly playerId: string;
  readonly playerActive: boolean;
  readonly onboardingComplete: boolean;
  readonly activeExternalIdentity: boolean;
  readonly areaId: string | null;
  readonly hasEligibleTeamPokemon: boolean;
  readonly activeEncounter: boolean;
  readonly activeBattle: boolean;
}

export interface ActivePvpContent {
  readonly contentReleaseId: string;
  readonly rulesetId: string;
}

export interface InsertAcceptedPvpEncounterInput {
  readonly challenge: PvpChallenge;
  readonly seed: EncryptedSeedEnvelope;
}

export interface ReplacePvpChallengeInput {
  readonly expectedRevision: number;
  readonly next: PvpChallenge;
}

export interface PvpChallengeTransaction {
  playerContexts(
    playerIds: readonly string[],
    lock?: boolean,
    contentReleaseId?: string,
  ): Promise<readonly PvpPlayerContext[]>;
  activeContent(): Promise<ActivePvpContent | null>;
  pinnedContentAvailable(contentReleaseId: string, rulesetId: string): Promise<boolean>;
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

export interface PvpStartRepositoryInput {
  readonly challengeId: string;
  readonly actorPlayerId: string;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
}

export interface PvpStartRepositoryOutput {
  readonly challengeId: string;
  readonly encounterId: string;
  readonly battleId: string;
  readonly turnWindowId: string;
  readonly replayed: boolean;
}

export interface PvpStartRepository {
  start(input: PvpStartRepositoryInput): Promise<Result<PvpStartRepositoryOutput>>;
}
