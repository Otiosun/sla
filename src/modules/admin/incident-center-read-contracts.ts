export type IncidentSignalSource = "ADMIN_OPERATION" | "INBOX" | "OUTBOX";
export type IncidentSignalState = "FAILED" | "DEAD";

export type IncidentRunbookKey =
  | "admin-operation-failed"
  | "inbox-processing-failed"
  | "outbox-delivery-failed"
  | "outbox-dead-letter";

export interface IncidentRunbookView {
  readonly key: IncidentRunbookKey;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly evidenceToCollect: readonly string[];
  readonly escalation: string;
}

export interface IncidentSignalEvidence {
  readonly source: IncidentSignalSource;
  readonly id: string;
  readonly correlationId: string;
  readonly state: IncidentSignalState;
  readonly kind: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly riskTier: number | null;
  readonly attempts: number | null;
  readonly occurredAt: Date;
}

export interface IncidentSignalView {
  readonly source: IncidentSignalSource;
  readonly id: string;
  readonly correlationId: string;
  readonly state: IncidentSignalState;
  readonly kind: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly riskTier: number | null;
  readonly attempts: number | null;
  readonly occurredAt: string;
  readonly runbook: IncidentRunbookView;
}

export interface IncidentCenterView {
  readonly signals: readonly IncidentSignalView[];
}

export interface IncidentCenterReadRepository {
  readRecent(limit: number): Promise<readonly IncidentSignalEvidence[]>;
}
