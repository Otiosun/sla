import type { PlayerId } from "../../shared-kernel/ids.js";
import type { RegistrationSnapshot } from "./contracts.js";

export type RegistrationRevisionStatus =
  | "SUBMITTED"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN";

export interface RegistrationDraftRecord {
  readonly playerId: PlayerId;
  readonly snapshot: RegistrationSnapshot;
  readonly revision: number;
}

export interface RegistrationRevisionRecord {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly sequenceNo: number;
  readonly status: RegistrationRevisionStatus;
  readonly snapshot: RegistrationSnapshot;
  readonly revision: number;
}

export interface SaveRegistrationDraftWrite {
  readonly playerId: PlayerId;
  readonly snapshot: RegistrationSnapshot;
  readonly expectedRevision: number | null;
}

export interface InsertRegistrationRevisionWrite {
  readonly playerId: PlayerId;
  readonly sequenceNo: number;
  readonly snapshot: RegistrationSnapshot;
}

export type RegistrationIdempotentOperation = "SUBMIT";

export interface RegistrationTransaction {
  loadDraft(playerId: PlayerId): Promise<RegistrationDraftRecord | null>;
  saveDraft(input: SaveRegistrationDraftWrite): Promise<RegistrationDraftRecord | null>;
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
  ): Promise<RegistrationRevisionRecord | null>;
}

export interface RegistrationRepository {
  transaction<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T>;
}
