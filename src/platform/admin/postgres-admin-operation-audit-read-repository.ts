import type { Pool } from "pg";
import type {
  AdminOperationAuditDecision,
  AdminOperationAuditEvidence,
  AdminOperationAuditOperationEvidence,
  AdminOperationAuditReadRepository,
  AdminOperationAuditTimelineEvidence,
} from "../../modules/admin/admin-operation-audit-read-contracts.js";
import type { AdminOperationStatus, AdminRiskTier } from "../../modules/admin/contracts.js";

interface OperationRow {
  readonly id: string;
  readonly principal_id: string;
  readonly capability_key: string;
  readonly operation_type: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly risk_tier: AdminRiskTier;
  readonly status: AdminOperationStatus;
  readonly correlation_id: string;
  readonly reason_recorded: boolean;
  readonly expected_revision: string | null;
  readonly revision: string;
  readonly policy_version: number;
  readonly requires_reason: boolean;
  readonly requires_expected_revision: boolean;
  readonly requires_simulation: boolean;
  readonly requires_confirmation: boolean;
  readonly required_approvals: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly applied_at: Date | null;
}

interface ConfirmationRow {
  readonly id: string;
  readonly principal_id: string;
  readonly created_at: Date;
}

interface ApprovalRow {
  readonly id: string;
  readonly principal_id: string;
  readonly decision: AdminOperationAuditDecision;
  readonly created_at: Date;
}

interface ChangeRow {
  readonly id: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly created_at: Date;
}

interface AuditRow {
  readonly id: string;
  readonly actor_principal_id: string | null;
  readonly action: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly occurred_at: Date;
}

function operationEvidence(row: OperationRow): AdminOperationAuditOperationEvidence {
  return {
    id: row.id,
    principalId: row.principal_id,
    capabilityKey: row.capability_key,
    operationType: row.operation_type,
    targetType: row.target_type,
    targetId: row.target_id,
    riskTier: row.risk_tier,
    status: row.status,
    correlationId: row.correlation_id,
    reasonRecorded: row.reason_recorded,
    expectedRevision: row.expected_revision,
    revision: row.revision,
    policy: {
      version: row.policy_version,
      requiresReason: row.requires_reason,
      requiresExpectedRevision: row.requires_expected_revision,
      requiresSimulation: row.requires_simulation,
      requiresConfirmation: row.requires_confirmation,
      requiredApprovals: row.required_approvals,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  };
}

function compareTimeline(
  left: AdminOperationAuditTimelineEvidence,
  right: AdminOperationAuditTimelineEvidence,
): number {
  const timeDelta = left.occurredAt.getTime() - right.occurredAt.getTime();
  return timeDelta === 0 ? left.eventId.localeCompare(right.eventId) : timeDelta;
}

export class PostgresAdminOperationAuditReadRepository
  implements AdminOperationAuditReadRepository
{
  public constructor(private readonly pool: Pool) {}

  public async reconstruct(operationId: string): Promise<AdminOperationAuditEvidence | null> {
    const operationResult = await this.pool.query<OperationRow>(
      `SELECT id,
              principal_id,
              capability_key,
              operation_type,
              target_type,
              target_id,
              risk_tier::integer AS risk_tier,
              status,
              correlation_id,
              (reason IS NOT NULL AND length(btrim(reason)) > 0) AS reason_recorded,
              expected_revision::text AS expected_revision,
              revision::text AS revision,
              policy_version,
              requires_reason,
              requires_expected_revision,
              requires_simulation,
              requires_confirmation,
              required_approvals,
              created_at,
              updated_at,
              applied_at
       FROM admin_operations
       WHERE id = $1`,
      [operationId],
    );

    const operation = operationResult.rows[0];
    if (operation === undefined) return null;

    const [confirmations, approvals, changes, auditEvents] = await Promise.all([
      this.pool.query<ConfirmationRow>(
        `SELECT id, principal_id, created_at
         FROM admin_operation_confirmations
         WHERE admin_operation_id = $1
         ORDER BY created_at, id`,
        [operationId],
      ),
      this.pool.query<ApprovalRow>(
        `SELECT id, principal_id, decision, created_at
         FROM admin_operation_approvals
         WHERE admin_operation_id = $1
         ORDER BY created_at, id`,
        [operationId],
      ),
      this.pool.query<ChangeRow>(
        `SELECT id, resource_type, resource_id, created_at
         FROM admin_operation_changes
         WHERE admin_operation_id = $1
         ORDER BY created_at, id`,
        [operationId],
      ),
      this.pool.query<AuditRow>(
        `SELECT id,
                CASE WHEN actor_type = 'ADMIN' THEN actor_id ELSE NULL END AS actor_principal_id,
                action,
                target_type AS resource_type,
                target_id AS resource_id,
                occurred_at
         FROM audit_events
         WHERE causation_id = $1
         ORDER BY occurred_at, id`,
        [operationId],
      ),
    ]);

    const timeline: AdminOperationAuditTimelineEvidence[] = [
      {
        kind: "PROPOSED",
        occurredAt: operation.created_at,
        actorPrincipalId: operation.principal_id,
        action: `${operation.operation_type}.proposed`,
        decision: null,
        resourceType: null,
        resourceId: null,
        eventId: operation.id,
      },
      ...confirmations.rows.map(
        (row): AdminOperationAuditTimelineEvidence => ({
          kind: "CONFIRMATION",
          occurredAt: row.created_at,
          actorPrincipalId: row.principal_id,
          action: `${operation.operation_type}.confirmation`,
          decision: null,
          resourceType: null,
          resourceId: null,
          eventId: row.id,
        }),
      ),
      ...approvals.rows.map(
        (row): AdminOperationAuditTimelineEvidence => ({
          kind: "APPROVAL",
          occurredAt: row.created_at,
          actorPrincipalId: row.principal_id,
          action: `${operation.operation_type}.approval`,
          decision: row.decision,
          resourceType: null,
          resourceId: null,
          eventId: row.id,
        }),
      ),
      ...changes.rows.map(
        (row): AdminOperationAuditTimelineEvidence => ({
          kind: "CHANGE",
          occurredAt: row.created_at,
          actorPrincipalId: null,
          action: `${operation.operation_type}.change`,
          decision: null,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          eventId: row.id,
        }),
      ),
      ...auditEvents.rows.map(
        (row): AdminOperationAuditTimelineEvidence => ({
          kind: "AUDIT",
          occurredAt: row.occurred_at,
          actorPrincipalId: row.actor_principal_id,
          action: row.action,
          decision: null,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          eventId: row.id,
        }),
      ),
    ];

    timeline.sort(compareTimeline);
    return {
      operation: operationEvidence(operation),
      timeline,
    };
  }
}
