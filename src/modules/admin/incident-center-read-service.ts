import type {
  IncidentCenterReadRepository,
  IncidentCenterView,
  IncidentSignalEvidence,
  IncidentSignalView,
} from "./incident-center-read-contracts.js";

interface IncidentCenterReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface IncidentCenterReadRequest {
  readonly principalId: string;
  readonly correlationId: string;
}

function incidentView(evidence: IncidentSignalEvidence): IncidentSignalView {
  return {
    source: evidence.source,
    id: evidence.id,
    correlationId: evidence.correlationId,
    state: evidence.state,
    kind: evidence.kind,
    targetType: evidence.targetType,
    targetId: evidence.targetId,
    riskTier: evidence.riskTier,
    attempts: evidence.attempts,
    occurredAt: evidence.occurredAt.toISOString(),
  };
}

export class IncidentCenterReadService {
  public constructor(
    private readonly authorizer: IncidentCenterReadAuthorizer,
    private readonly repository: IncidentCenterReadRepository,
  ) {}

  public async getSnapshot(request: IncidentCenterReadRequest): Promise<IncidentCenterView> {
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "incident.center.read",
      input: {},
      correlationId: request.correlationId,
    });

    const evidence = await this.repository.readRecent(25);
    return { signals: evidence.map(incidentView) };
  }
}
