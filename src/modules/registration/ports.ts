import type { PlayerId } from "../../shared-kernel/ids.js";
import type {
  RegistrationConversationEditingMode,
  RegistrationConversationField,
  RegistrationConversationRecord,
  RegistrationConversationState,
} from "./conversation-state.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";

export type RegistrationRevisionStatus =
  | "SUBMITTED"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN";

export interface RegistrationDraftRecord {
  readonly playerId: PlayerId;
  readonly snapshot: RegistrationDraftInput;
  readonly revision: number;
}

export interface RegistrationRevisionRecord {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly sequenceNo: number;
  readonly status: RegistrationRevisionStatus;
  readonly snapshot: RegistrationSnapshot;
  readonly revision: number;
  readonly decidedByAdminPrincipalId?: string | null;
}

export interface SaveRegistrationDraftWrite {
  readonly playerId: PlayerId;
  readonly snapshot: RegistrationDraftInput;
  readonly expectedRevision: number | null;
}

export interface SaveRegistrationConversationWrite {
  readonly playerId: PlayerId;
  readonly chatRef: string;
  readonly state: RegistrationConversationState;
  readonly editingMode: RegistrationConversationEditingMode | null;
  readonly currentField: RegistrationConversationField | null;
  readonly editField: RegistrationConversationField | null;
  readonly activePromptOutboxIdempotencyKey: string | null;
  readonly pendingReviewId?: string | null;
  readonly pendingReviewRevision?: number | null;
  readonly draftRevision: number | null;
  readonly lastInboxMessageId: string | null;
  readonly expectedRevision: number | null;
}

export interface InsertRegistrationRevisionWrite {
  readonly playerId: PlayerId;
  readonly sequenceNo: number;
  readonly snapshot: RegistrationSnapshot;
}

export type RegistrationIdempotentOperation = "SUBMIT" | "REQUEST_CHANGES" | "APPROVE" | "REJECT";

export interface RegistrationTransaction {
  lockPlayer(playerId: PlayerId): Promise<void>;
  loadDraft(playerId: PlayerId): Promise<RegistrationDraftRecord | null>;
  saveDraft(input: SaveRegistrationDraftWrite): Promise<RegistrationDraftRecord | null>;
  deleteDraft(playerId: PlayerId): Promise<void>;
  loadConversation(playerId: PlayerId): Promise<RegistrationConversationRecord | null>;
  saveConversation(
    input: SaveRegistrationConversationWrite,
  ): Promise<RegistrationConversationRecord | null>;
  deleteConversation(playerId: PlayerId): Promise<void>;
  loadCurrentRevision(playerId: PlayerId): Promise<RegistrationRevisionRecord | null>;
  loadRevisionById(revisionId: string): Promise<RegistrationRevisionRecord | null>;
  loadIdempotencyReceipt(
    operation: RegistrationIdempotentOperation,
    idempotencyKey: string,
  ): Promise<RegistrationRevisionRecord | null>;
  insertRevision(input: InsertRegistrationRevisionWrite): Promise<RegistrationRevisionRecord>;
  saveIdempotencyReceipt(
    operation: RegistrationIdempotentOperation,
    idempotencyKey: string,
    revisionId: string,
  ): Promise<void>;
  updateRevisionStatus(
    revisionId: string,
    expectedRevision: number,
    status: RegistrationRevisionStatus,
    decidedByAdminPrincipalId?: string,
  ): Promise<RegistrationRevisionRecord | null>;
}

export interface RegistrationRepository {
  transaction<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T>;
}
