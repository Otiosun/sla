import type { PlayerId } from "../../shared-kernel/ids.js";

export type WorldServiceKind = "POKEMART" | "POKEMON_CENTER" | "PC";
export type WorldServiceSessionState = "OPEN" | "CLOSED";

export interface SceneProofRecord {
  readonly proofId: string;
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly sourceInboxMessageId: string;
  readonly lineCount: number;
  readonly createdAt: Date;
  readonly consumedAt: Date | null;
}

export interface WorldServiceSessionRecord {
  readonly sessionId: string;
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly serviceKind: WorldServiceKind;
  readonly state: WorldServiceSessionState;
  readonly sceneProofId: string | null;
  readonly expectedReplyOutboxIdempotencyKey: string | null;
  readonly expectedReplyExternalMessageId: string | null;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

export interface RecordSceneProofInput {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly sourceInboxMessageId: string;
  readonly text: string;
}

export interface OpenWorldServiceVisitInput {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly serviceKind: WorldServiceKind;
}

export interface CloseWorldServiceVisitInput {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
}

export interface SetWorldServiceActivePromptInput {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
  readonly outboxIdempotencyKey: string;
  readonly externalMessageId: string;
}
