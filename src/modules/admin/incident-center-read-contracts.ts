export type IncidentSignalSource = "ADMIN_OPERATION" | "INBOX" | "OUTBOX";
export type IncidentSignalState = "FAILED" | "DEAD";

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
}

export interface IncidentCenterView {
  readonly signals: readonly IncidentSignalView[];
}

export interface IncidentCenterReadRepository {
  readRecent(limit: number): Promise<readonly IncidentSignalEvidence[]>;
}
