import type { Pool } from "pg";
import {
  type AdminOperationAuditApproval,
  type AdminOperationAuditBundle,
  type AdminOperationAuditChange,
  type AdminOperationAuditConfirmation,
  type AdminOperationAuditEvent,
  type AdminOperationAuditOperation,
  type AdminOperationBatchEvidence,
  type AdminOperationOwnerEvidence,
  type AdminOwnerEvidenceSource,
} from "../../modules/admin/audit-contracts.js";
import type { AdminOperationAuditRepository } from "../../modules/admin/audit-ports.js";
import {
  AdminAuthorizationModeSchema,
  AdminOperationPolicySchema,
  AdminOperationStatusSchema,
  AdminRiskTierSchema,
} from "../../modules/admin/contracts.js";

interface OperationRow {
  id: string;
  principal_id: string;
  capability_key: string;
  operation_type: string;
  target_type: string;
  target_id: string | null;
  risk_tier: number;
  status: string;
  reason: string | null;
  expected_revision: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  correlation_id: string;
  policy_version: number;
  authorization_mode: string;
  requires_reason: boolean;
  requires_expected_revision: boolean;
  requires_simulation: boolean;
  requires_confirmation: boolean;
  required_approvals: number;
  revision: string;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

function toOperation(row: OperationRow): AdminOperationAuditOperation {
  return {
    id: row.id,
    principalId: row.principal_id,
    capabilityKey: row.capability_key,
    operationType: row.operation_type,
    targetType: row.target_type,
    targetId: row.target_id,
    riskTier: AdminRiskTierSchema.parse(row.risk_tier),
    authorizationMode: AdminAuthorizationModeSchema.parse(row.authorization_mode),
    status: AdminOperationStatusSchema.parse(row.status),
    reason: row.reason,
    expectedRevision: row.expected_revision === null ? null : BigInt(row.expected_revision),
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    input: row.input,
    result: row.result,
    correlationId: row.correlation_id,
    policy: AdminOperationPolicySchema.parse({
      version: row.policy_version,
      requiresReason: row.requires_reason,
      requiresExpectedRevision: row.requires_expected_revision,
      requiresSimulation: row.requires_simulation,
      requiresConfirmation: row.requires_confirmation,
      requiredApprovals: row.required_approvals,
    }),
    revision: BigInt(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  };
}

export class PostgresAdminOperationAuditRepository implements AdminOperationAuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async getOperationAudit(operationId: string): Promise<AdminOperationAuditBundle | null> {
    const operationResult = await this.pool.query<OperationRow>(
      `SELECT id, principal_id, capability_key, operation_type, target_type, target_id,
              risk_tier, status, reason, expected_revision::text, idempotency_key,
              request_fingerprint, input, result, correlation_id, policy_version,
              authorization_mode, requires_reason, requires_expected_revision,
              requires_simulation, requires_confirmation, required_approvals,
              revision::text, created_at, updated_at, applied_at
       FROM admin_operations
       WHERE id = $1`,
      [operationId],
    );
    const operationRow = operationResult.rows[0];
    if (operationRow === undefined) return null;

    const [confirmations, approvals, changes, auditEvents, ownerEvidence, batchEvidence] =
      await Promise.all([
        this.pool.query<{
          principal_id: string;
          request_fingerprint: string;
          created_at: Date;
        }>(
          `SELECT principal_id, request_fingerprint, created_at
           FROM admin_operation_confirmations
           WHERE admin_operation_id = $1
           ORDER BY created_at, id`,
          [operationId],
        ),
        this.pool.query<{
          principal_id: string;
          request_fingerprint: string;
          decision: "APPROVED" | "REJECTED";
          reason: string;
          created_at: Date;
        }>(
          `SELECT principal_id, request_fingerprint, decision, reason, created_at
           FROM admin_operation_approvals
           WHERE admin_operation_id = $1
           ORDER BY created_at, id`,
          [operationId],
        ),
        this.pool.query<{
          resource_type: string;
          resource_id: string | null;
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown> | null;
          created_at: Date;
        }>(
          `SELECT resource_type, resource_id, before_data, after_data, created_at
           FROM admin_operation_changes
           WHERE admin_operation_id = $1
           ORDER BY created_at, id`,
          [operationId],
        ),
        this.pool.query<{
          actor_type: string;
          actor_id: string | null;
          action: string;
          target_type: string;
          target_id: string | null;
          risk_tier: number | null;
          reason: string | null;
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown> | null;
          metadata: Record<string, unknown>;
          correlation_id: string | null;
          causation_id: string | null;
          occurred_at: Date;
        }>(
          `SELECT actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
                  before_data, after_data, metadata, correlation_id, causation_id, occurred_at
           FROM audit_events
           WHERE metadata->>'adminOperationId' = $1 OR causation_id = $1::uuid
           ORDER BY occurred_at, id`,
          [operationId],
        ),
        this.loadOwnerEvidence(operationId),
        this.pool.query<{
          id: string;
          relation: "PREVIEW" | "EXECUTE";
          status: string;
          child_operation_type: string;
          child_capability_key: string;
          target_count: number;
          checkpoint_ordinal: number;
          success_count: number;
          failure_count: number;
          report: Record<string, unknown>;
          correlation_id: string;
          created_at: Date;
          started_at: Date | null;
          completed_at: Date | null;
        }>(
          `SELECT id,
                  CASE WHEN preview_admin_operation_id = $1 THEN 'PREVIEW' ELSE 'EXECUTE' END AS relation,
                  status, child_operation_type, child_capability_key, target_count,
                  checkpoint_ordinal, success_count, failure_count, report, correlation_id,
                  created_at, started_at, completed_at
           FROM admin_batches
           WHERE preview_admin_operation_id = $1 OR execute_admin_operation_id = $1
           ORDER BY created_at, id`,
          [operationId],
        ),
      ]);

    return {
      operation: toOperation(operationRow),
      confirmations: confirmations.rows.map(
        (row): AdminOperationAuditConfirmation => ({
          principalId: row.principal_id,
          requestFingerprint: row.request_fingerprint,
          createdAt: row.created_at,
        }),
      ),
      approvals: approvals.rows.map(
        (row): AdminOperationAuditApproval => ({
          principalId: row.principal_id,
          requestFingerprint: row.request_fingerprint,
          decision: row.decision,
          reason: row.reason,
          createdAt: row.created_at,
        }),
      ),
      changes: changes.rows.map(
        (row): AdminOperationAuditChange => ({
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          beforeData: row.before_data,
          afterData: row.after_data,
          createdAt: row.created_at,
        }),
      ),
      auditEvents: auditEvents.rows.map(
        (row): AdminOperationAuditEvent => ({
          actorType: row.actor_type,
          actorId: row.actor_id,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          riskTier: row.risk_tier,
          reason: row.reason,
          beforeData: row.before_data,
          afterData: row.after_data,
          metadata: row.metadata,
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          occurredAt: row.occurred_at,
        }),
      ),
      ownerEvidence,
      batchEvidence: batchEvidence.rows.map(
        (row): AdminOperationBatchEvidence => ({
          batchId: row.id,
          relation: row.relation,
          status: row.status,
          childOperationType: row.child_operation_type,
          childCapabilityKey: row.child_capability_key,
          targetCount: row.target_count,
          checkpointOrdinal: row.checkpoint_ordinal,
          successCount: row.success_count,
          failureCount: row.failure_count,
          report: row.report,
          correlationId: row.correlation_id,
          createdAt: row.created_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        }),
      ),
    };
  }

  private async loadOwnerEvidence(operationId: string): Promise<AdminOperationOwnerEvidence[]> {
    const result = await this.pool.query<{
      source: AdminOwnerEvidenceSource;
      kind: string;
      subject_id: string | null;
      resource_id: string | null;
      request_fingerprint: string | null;
      correlation_id: string | null;
      evidence: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT * FROM (
         SELECT 'POKEMON_ADMIN_CLAIM'::text AS source, operation_kind AS kind,
                player_id::text AS subject_id, pokemon_instance_id::text AS resource_id,
                request_fingerprint, correlation_id::text,
                jsonb_build_object('beforeData', before_data, 'afterData', after_data, 'result', result) AS evidence,
                created_at
         FROM pokemon_admin_operation_claims WHERE idempotency_key = $1
         UNION ALL
         SELECT 'ENCOUNTER_ADMIN_CLAIM', operation_kind, player_id::text, encounter_id::text,
                request_fingerprint, correlation_id::text,
                jsonb_build_object('beforeData', before_data, 'afterData', after_data, 'result', result), created_at
         FROM encounter_admin_operation_claims WHERE idempotency_key = $1
         UNION ALL
         SELECT 'CATALOG_ADMIN_CLAIM', operation_kind, content_release_id::text, resource_id::text,
                request_fingerprint, correlation_id::text,
                jsonb_build_object('resourceKind', resource_kind, 'beforeRevision', before_revision::text,
                                   'afterRevision', after_revision::text, 'beforeData', before_data,
                                   'afterData', after_data, 'result', result), created_at
         FROM catalog_admin_operation_claims WHERE idempotency_key = $1
         UNION ALL
         SELECT 'CATALOG_RELEASE_ADMIN_CLAIM', operation_kind, content_release_id::text, content_release_id::text,
                request_fingerprint, correlation_id::text,
                jsonb_build_object('expectedRevision', expected_revision::text, 'beforeStatus', before_status,
                                   'afterStatus', after_status, 'beforeData', before_data,
                                   'afterData', after_data, 'result', result), created_at
         FROM catalog_release_admin_operation_claims WHERE idempotency_key = $1
         UNION ALL
         SELECT 'INVENTORY_LEDGER', source_type, player_id::text, item_id::text, NULL, correlation_id::text,
                jsonb_build_object('delta', delta::text, 'ledgerId', id::text, 'idempotencyScope', idempotency_scope,
                                   'idempotencyKey', idempotency_key, 'reason', reason), created_at
         FROM inventory_ledger WHERE source_type = 'ADMIN_OPERATION' AND source_id = $1
         UNION ALL
         SELECT 'WALLET_LEDGER', source_type, player_id::text, currency_id::text, NULL, correlation_id::text,
                jsonb_build_object('delta', delta::text, 'ledgerId', id::text, 'idempotencyScope', idempotency_scope,
                                   'idempotencyKey', idempotency_key, 'reason', reason), created_at
         FROM wallet_ledger WHERE source_type = 'ADMIN_OPERATION' AND source_id = $1
         UNION ALL
         SELECT 'TRAINER_PROGRESS_LEDGER', source_type, player_id::text, player_id::text, NULL, correlation_id::text,
                jsonb_build_object('delta', delta::text, 'ledgerId', id::text, 'idempotencyScope', idempotency_scope,
                                   'idempotencyKey', idempotency_key, 'reason', reason), created_at
         FROM trainer_progress_ledger WHERE source_type = 'ADMIN_OPERATION' AND source_id = $1
         UNION ALL
         SELECT 'BATTLE_EVENT', event_type, NULL, battle_id::text, NULL, correlation_id::text,
                jsonb_build_object('seq', seq::text, 'battleVersion', battle_version::text, 'payload', payload,
                                   'causationId', causation_id::text), occurred_at
         FROM battle_events WHERE causation_id = $1::uuid
       ) evidence
       ORDER BY created_at, source, resource_id`,
      [operationId],
    );

    return result.rows.map(
      (row): AdminOperationOwnerEvidence => ({
        source: row.source,
        kind: row.kind,
        subjectId: row.subject_id,
        resourceId: row.resource_id,
        requestFingerprint: row.request_fingerprint,
        correlationId: row.correlation_id,
        evidence: row.evidence,
        createdAt: row.created_at,
      }),
    );
  }
}
