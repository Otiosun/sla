import type { PlayerId } from "../../shared-kernel/ids.js";
import type {
  SceneProofRecord,
  WorldServiceKind,
  WorldServiceSessionRecord,
} from "./contracts.js";

export interface InsertSceneProofWrite {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly sourceInboxMessageId: string;
  readonly lineCount: number;
  readonly createdAt: Date;
}

export interface ClaimSceneProofWrite {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly consumedAt: Date;
}

export interface CreateWorldServiceSessionWrite {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly serviceKind: WorldServiceKind;
  readonly sceneProofId: string | null;
  readonly createdAt: Date;
}

export interface CloseWorldServiceSessionWrite {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
  readonly closedAt: Date;
}

export interface SetWorldServicePromptWrite {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
  readonly outboxIdempotencyKey: string;
  readonly externalMessageId: string;
  readonly updatedAt: Date;
}

export interface WorldServiceSessionTransaction {
  insertSceneProof(input: InsertSceneProofWrite): Promise<SceneProofRecord>;
  claimSceneProof(input: ClaimSceneProofWrite): Promise<SceneProofRecord | null>;
  activeSession(playerId: PlayerId, lock?: boolean): Promise<WorldServiceSessionRecord | null>;
  createSession(input: CreateWorldServiceSessionWrite): Promise<WorldServiceSessionRecord>;
  closeSession(input: CloseWorldServiceSessionWrite): Promise<WorldServiceSessionRecord | null>;
  setActivePrompt(input: SetWorldServicePromptWrite): Promise<WorldServiceSessionRecord | null>;
}

export interface WorldServiceSessionRepository {
  transaction<T>(work: (transaction: WorldServiceSessionTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: WorldServiceSessionTransaction) => Promise<T>): Promise<T>;
}
