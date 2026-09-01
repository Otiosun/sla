import type { Pool } from "pg";
import type {
  IncidentCenterReadRepository,
  IncidentSignalEvidence,
  IncidentSignalSource,
  IncidentSignalState,
} from "../../modules/admin/incident-center-read-contracts.js";

interface IncidentSignalRow {
  readonly source: IncidentSignalSource;
  readonly id: string;
  readonly correlation_id: string;
  readonly state: IncidentSignalState;
  readonly kind: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly risk_tier: number | null;
  readonly attempts: number | null;
  readonly occurred_at: Date;
}

function incidentEvidence(row: IncidentSignalRow): IncidentSignalEvidence {
  return {
    source: row.source,
    id: row.id,
    correlationId: row.correlation_id,
    state: row.state,
    kind: row.kind,
    targetType: row.target_type,
    targetId: row.target_id,
    riskTier: row.risk_tier,
    attempts: row.attempts,
    occurredAt: row.occurred_at,
  };
}

export class PostgresIncidentCenterReadRepository implements IncidentCenterReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async readRecent(limit: number): Promise<readonly IncidentSignalEvidence[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new RangeError("Incident Center read limit must be between 1 and 25");
    }

    const result = await this.pool.query<IncidentSignalRow>(
      `SELECT source, id, correlation_id, state, kind, target_type, target_id,
              risk_tier, attempts, occurred_at
       FROM (
         SELECT
           'ADMIN_OPERATION'::text AS source,
           id,
           correlation_id,
           status::text AS state,
           operation_type::text AS kind,
           target_type::text AS target_type,
           target_id,
           risk_tier::integer AS risk_tier,
           NULL::integer AS attempts,
           updated_at AS occurred_at
         FROM admin_operations
         WHERE status = 'FAILED'

         UNION ALL

         SELECT
           'INBOX'::text AS source,
           id,
           correlation_id,
           status::text AS state,
           'INBOX_MESSAGE'::text AS kind,
           NULL::text AS target_type,
           NULL::uuid AS target_id,
           NULL::integer AS risk_tier,
           attempts,
           COALESCE(processing_started_at, received_at) AS occurred_at
         FROM inbox_messages
         WHERE status = 'FAILED'

         UNION ALL

         SELECT
           'OUTBOX'::text AS source,
           id,
           correlation_id,
           status::text AS state,
           'OUTBOX_MESSAGE'::text AS kind,
           NULL::text AS target_type,
           NULL::uuid AS target_id,
           NULL::integer AS risk_tier,
           attempts,
           COALESCE(sending_started_at, created_at) AS occurred_at
         FROM outbox_messages
         WHERE status IN ('FAILED', 'DEAD')
       ) incident_signals
       ORDER BY occurred_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(incidentEvidence);
  }
}
