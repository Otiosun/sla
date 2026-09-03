export type MessagingInboxStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";
export type MessagingOutboxStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "DEAD";

export interface MessagingInboxCounts {
  readonly RECEIVED: number;
  readonly PROCESSING: number;
  readonly PROCESSED: number;
  readonly FAILED: number;
}

export interface MessagingOutboxCounts {
  readonly PENDING: number;
  readonly SENDING: number;
  readonly SENT: number;
  readonly FAILED: number;
  readonly DEAD: number;
}

export interface MessagingInboxMetadataEvidence {
  readonly id: string;
  readonly status: MessagingInboxStatus;
  readonly attempts: number;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processingStartedAt: Date | null;
}

export interface MessagingOutboxMetadataEvidence {
  readonly id: string;
  readonly status: MessagingOutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
  readonly sendingStartedAt: Date | null;
}

export interface MessagingOperationsEvidence {
  readonly inbox: {
    readonly counts: MessagingInboxCounts;
    readonly recent: readonly MessagingInboxMetadataEvidence[];
  };
  readonly outbox: {
    readonly counts: MessagingOutboxCounts;
    readonly recent: readonly MessagingOutboxMetadataEvidence[];
    readonly deadLetter: readonly MessagingOutboxMetadataEvidence[];
  };
}

export interface MessagingInboxMetadataView {
  readonly id: string;
  readonly status: MessagingInboxStatus;
  readonly attempts: number;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly processingStartedAt: string | null;
}

export interface MessagingOutboxMetadataView {
  readonly id: string;
  readonly status: MessagingOutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly sendingStartedAt: string | null;
}

export interface MessagingOperationsView {
  readonly inbox: {
    readonly counts: MessagingInboxCounts;
    readonly recent: readonly MessagingInboxMetadataView[];
  };
  readonly outbox: {
    readonly counts: MessagingOutboxCounts;
    readonly recent: readonly MessagingOutboxMetadataView[];
    readonly deadLetter: readonly MessagingOutboxMetadataView[];
  };
}

export interface MessagingOperationsReadRepository {
  readSnapshot(limit: number): Promise<MessagingOperationsEvidence>;
}
