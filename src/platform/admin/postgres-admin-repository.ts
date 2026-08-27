import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  AdminAuthorizationModeSchema,
  AdminOperationPolicySchema,
  AdminOperationStatusSchema,
  AdminRiskTierSchema,
  AdminRoleAssignInputSchema,
  type AdminAuthorizationSnapshot,
  type AdminOperationRecord,
  type AdminOperationStatus,
  type AdminRoleAssignInput,
  type AdminSimulationResult,
} from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type {
  AdminOperationRepository,
  AdminRoleAssignmentPort,
  CreateAdminOperationInput,
} from "../../modules/admin/ports.js";
import { withTransaction } from "../db/transaction.js";

interface AdminOperationRow {
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
  applied_at: Date | null;
}

const OPERATION_SELECT = `
  SELECT id, principal_id, capability_key, operation_type, target_type, target_id,
         risk_tier, status, reason, expected_revision::text, idempotency_key,
         request_fingerprint, input, result, correlation_id, policy_version,
         authorization_mode, requires_reason, requires_expected_revision,
         requires_simulation, requires_confirmation, required_approvals,
         revision::text, applied_at
  FROM admin_operations`;

function toOperation(row: AdminOperationRow): AdminOperationRecord {
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
    appliedAt: row.applied_at,
  };
}

async function getOperationWithClient(
  client: PoolClient,
  operationId: string,
  lock = false,
): Promise<AdminOperationRecord | null> {
  const result = await client.query<AdminOperationRow>(
    `${OPERATION_SELECT} WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [operationId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toOperation(row);
}

export class PostgresAdminRepository implements AdminOperationRepository, AdminRoleAssignmentPort {
  public constructor(private readonly pool: Pool) {}

  public async getAuthorizationSnapshot(
    principalId: string,
  ): Promise<AdminAuthorizationSnapshot | null> {
    const principal = await this.pool.query<{ status: "ACTIVE" | "DISABLED" }>(
      `SELECT status FROM admin_principals WHERE id = $1`,
      [principalId],
    );
    const row = principal.rows[0];
    if (row === undefined) return null;
    const grants = await this.pool.query<{ key: string; risk_tier: number }>(
      `SELECT DISTINCT capability.key, capability.risk_tier
       FROM admin_principal_roles principal_role
       JOIN admin_role_capabilities role_capability ON role_capability.role_id = principal_role.role_id
       JOIN capabilities capability ON capability.id = role_capability.capability_id
       WHERE principal_role.principal_id = $1
       ORDER BY capability.key`,
      [principalId],
    );
    const scopes = await this.pool.query<{ scope_type: string; scope_id: string | null }>(
      `SELECT scope_type, scope_id
       FROM admin_principal_scopes
       WHERE principal_id = $1 AND status = 'ACTIVE'
       ORDER BY scope_type, scope_id NULLS FIRST`,
      [principalId],
    );
    return {
      principalId,
      status: row.status,
      capabilities: grants.rows.map((grant) => ({
        key: grant.key,
        riskTier: AdminRiskTierSchema.parse(grant.risk_tier),
      })),
      scopes: scopes.rows.map((scope) => ({
        scopeType: scope.scope_type as "GLOBAL" | "PLAYER" | "REGION" | "AREA",
        scopeId: scope.scope_id,
      })),
    };
  }

  public async createOrReplayOperation(
    input: CreateAdminOperationInput,
  ): Promise<{ operation: AdminOperationRecord; replayed: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin_operations(
           id, principal_id, capability_key, operation_type, target_type, target_id,
           risk_tier, status, reason, expected_revision, idempotency_key,
           request_fingerprint, input, correlation_id, policy_version,
           authorization_mode, requires_reason, requires_expected_revision,
           requires_simulation, requires_confirmation, required_approvals
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
           $14, $15, $16, $17, $18, $19, $20, $21
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.principalId,
          input.capabilityKey,
          input.operationType,
          input.target.type,
          input.target.id,
          input.riskTier,
          input.status,
          input.reason,
          input.expectedRevision?.toString() ?? null,
          input.idempotencyKey,
          input.requestFingerprint,
          JSON.stringify(input.input),
          input.correlationId,
          input.policyVersion,
          input.authorizationMode,
          input.requiresReason,
          input.requiresExpectedRevision,
          input.requiresSimulation,
          input.requiresConfirmation,
          input.requiredApprovals,
        ],
      );
      const created = inserted.rowCount === 1;
      const lookup = created
        ? await getOperationWithClient(client, input.id)
        : await client
            .query<AdminOperationRow>(`${OPERATION_SELECT} WHERE idempotency_key = $1`, [
              input.idempotencyKey,
            ])
            .then((result) => (result.rows[0] === undefined ? null : toOperation(result.rows[0])));
      if (lookup === null) {
        throw new Error("Failed to resolve admin operation after idempotency claim");
      }
      return { operation: lookup, replayed: !created };
    });
  }

  public async getOperation(operationId: string): Promise<AdminOperationRecord | null> {
    const result = await this.pool.query<AdminOperationRow>(`${OPERATION_SELECT} WHERE id = $1`, [
      operationId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  public async saveSimulation(
    operationId: string,
    expectedOperationRevision: bigint,
    result: AdminSimulationResult,
    nextStatus: AdminOperationStatus,
  ): Promise<AdminOperationRecord> {
    const updated = await this.pool.query(
      `UPDATE admin_operations
       SET result = $3::jsonb, status = $4, revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $2 AND status = 'VALIDATED'`,
      [
        operationId,
        expectedOperationRevision.toString(),
        JSON.stringify({ simulation: result }),
        nextStatus,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        "Simulation lost operation revision/state race",
      );
    }
    const operation = await this.getOperation(operationId);
    if (operation === null) throw new Error("Operation disappeared after simulation");
    return operation;
  }

  public async recordConfirmation(
    operationId: string,
    principalId: string,
    requestFingerprint: string,
    nextStatus: AdminOperationStatus,
  ): Promise<AdminOperationRecord> {
    return withTransaction(this.pool, async (client) => {
      const operation = await getOperationWithClient(client, operationId, true);
      if (operation === null) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      const existing = await client.query<{ request_fingerprint: string }>(
        `SELECT request_fingerprint FROM admin_operation_confirmations
         WHERE admin_operation_id = $1 AND principal_id = $2`,
        [operationId, principalId],
      );
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].request_fingerprint !== requestFingerprint) {
          throw new AdminError(
            ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "Confirmation fingerprint mismatch",
          );
        }
        return operation;
      }
      if (operation.status !== "PENDING_CONFIRMATION") {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          `Confirmation not allowed from ${operation.status}`,
        );
      }
      await client.query(
        `INSERT INTO admin_operation_confirmations(
           id, admin_operation_id, principal_id, request_fingerprint
         ) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), operationId, principalId, requestFingerprint],
      );
      await client.query(
        `UPDATE admin_operations
         SET status = $2, revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [operationId, nextStatus],
      );
      const result = await getOperationWithClient(client, operationId);
      if (result === null) throw new Error("Operation disappeared after confirmation");
      return result;
    });
  }

  public async recordApproval(
    operationId: string,
    principalId: string,
    requestFingerprint: string,
    reason: string,
  ): Promise<AdminOperationRecord> {
    return withTransaction(this.pool, async (client) => {
      const operation = await getOperationWithClient(client, operationId, true);
      if (operation === null) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      const existing = await client.query<{ request_fingerprint: string; decision: string }>(
        `SELECT request_fingerprint, decision FROM admin_operation_approvals
         WHERE admin_operation_id = $1 AND principal_id = $2`,
        [operationId, principalId],
      );
      if (existing.rows[0] !== undefined) {
        if (
          existing.rows[0].request_fingerprint !== requestFingerprint ||
          existing.rows[0].decision !== "APPROVED"
        ) {
          throw new AdminError(ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, "Approval replay mismatch");
        }
        return operation;
      }
      if (operation.status !== "PENDING_APPROVAL") {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          `Approval not allowed from ${operation.status}`,
        );
      }
      await client.query(
        `INSERT INTO admin_operation_approvals(
           id, admin_operation_id, principal_id, request_fingerprint, decision, reason
         ) VALUES ($1, $2, $3, $4, 'APPROVED', $5)`,
        [randomUUID(), operationId, principalId, requestFingerprint, reason],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM admin_operation_approvals
         WHERE admin_operation_id = $1
           AND request_fingerprint = $2
           AND decision = 'APPROVED'
           AND principal_id <> $3`,
        [operationId, requestFingerprint, operation.principalId],
      );
      const nextStatus =
        Number(count.rows[0]?.count ?? "0") >= operation.policy.requiredApprovals
          ? "READY"
          : "PENDING_APPROVAL";
      await client.query(
        `UPDATE admin_operations
         SET status = $2, revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [operationId, nextStatus],
      );
      const result = await getOperationWithClient(client, operationId);
      if (result === null) throw new Error("Operation disappeared after approval");
      return result;
    });
  }

  public async simulateRoleAssignment(input: AdminRoleAssignInput): Promise<AdminSimulationResult> {
    const parsed = AdminRoleAssignInputSchema.parse(input);
    const result = await this.pool.query<{
      revision: string;
      principal_status: string;
      role_exists: boolean;
      assigned: boolean;
    }>(
      `SELECT principal.revision::text AS revision,
              principal.status AS principal_status,
              EXISTS(SELECT 1 FROM admin_roles role WHERE role.id = $2) AS role_exists,
              EXISTS(
                SELECT 1 FROM admin_principal_roles relation
                WHERE relation.principal_id = $1 AND relation.role_id = $2
              ) AS assigned
       FROM admin_principals principal
       WHERE principal.id = $1`,
      [parsed.principalId, parsed.roleId],
    );
    const row = result.rows[0];
    if (row === undefined || !row.role_exists) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Principal or role not found");
    }
    return {
      summary: {
        operation: "admin.role.assign",
        targetRevision: row.revision,
        changes: row.assigned ? 0 : 1,
      },
      before: {
        roleAssigned: row.assigned,
        principalStatus: row.principal_status,
        revision: row.revision,
      },
      after: {
        roleAssigned: true,
        principalStatus: row.principal_status,
        revision: row.assigned ? row.revision : (BigInt(row.revision) + 1n).toString(),
      },
    };
  }

  public async applyRoleAssignment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminRoleAssignInput,
  ): Promise<AdminOperationRecord> {
    const parsed = AdminRoleAssignInputSchema.parse(input);
    return withTransaction(this.pool, async (client) => {
      const locked = await getOperationWithClient(client, operation.id, true);
      if (locked === null) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      if (locked.status === "APPLIED") return locked;
      if (locked.status !== "READY" || locked.operationType !== "admin.role.assign") {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          `Role assignment cannot apply from ${locked.status}`,
        );
      }
      if (locked.expectedRevision === null) {
        throw new AdminError(
          ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
          "Role assignment requires expectedRevision",
        );
      }
      if (locked.policy.requiresConfirmation) {
        const confirmation = await client.query<{ ok: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM admin_operation_confirmations
             WHERE admin_operation_id = $1
               AND principal_id = $2
               AND request_fingerprint = $3
           ) AS ok`,
          [locked.id, locked.principalId, locked.requestFingerprint],
        );
        if (confirmation.rows[0]?.ok !== true) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
            "Required confirmation evidence is missing",
          );
        }
      }
      if (locked.policy.requiredApprovals > 0) {
        const approvals = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM admin_operation_approvals
           WHERE admin_operation_id = $1
             AND request_fingerprint = $2
             AND decision = 'APPROVED'
             AND principal_id <> $3`,
          [locked.id, locked.requestFingerprint, locked.principalId],
        );
        if (Number(approvals.rows[0]?.count ?? "0") < locked.policy.requiredApprovals) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
            "Required independent approvals are missing",
          );
        }
      }

      const principal = await client.query<{ revision: string; status: string }>(
        `SELECT revision::text, status FROM admin_principals WHERE id = $1 FOR UPDATE`,
        [parsed.principalId],
      );
      const principalRow = principal.rows[0];
      if (principalRow === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Target principal not found");
      }
      const role = await client.query(`SELECT 1 FROM admin_roles WHERE id = $1`, [parsed.roleId]);
      if (role.rowCount !== 1) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Role not found");
      }
      if (BigInt(principalRow.revision) !== locked.expectedRevision) {
        throw new AdminError(
          ADMIN_ERROR_CODES.REVISION_CONFLICT,
          "Target principal revision changed",
          {
            expectedRevision: locked.expectedRevision.toString(),
            actualRevision: principalRow.revision,
          },
        );
      }
      const assignedBefore = await client.query(
        `SELECT 1 FROM admin_principal_roles WHERE principal_id = $1 AND role_id = $2`,
        [parsed.principalId, parsed.roleId],
      );
      const wasAssigned = assignedBefore.rowCount === 1;
      let targetRevision = locked.expectedRevision;
      if (!wasAssigned) {
        await client.query(
          `INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`,
          [parsed.principalId, parsed.roleId],
        );
        const updated = await client.query<{ revision: string }>(
          `UPDATE admin_principals
           SET revision = revision + 1
           WHERE id = $1 AND revision = $2
           RETURNING revision::text`,
          [parsed.principalId, locked.expectedRevision.toString()],
        );
        const revisionRow = updated.rows[0];
        if (revisionRow === undefined) {
          throw new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, "Principal CAS failed");
        }
        targetRevision = BigInt(revisionRow.revision);
      }
      const before = {
        principalId: parsed.principalId,
        roleId: parsed.roleId,
        roleAssigned: wasAssigned,
        revision: locked.expectedRevision.toString(),
      };
      const after = {
        principalId: parsed.principalId,
        roleId: parsed.roleId,
        roleAssigned: true,
        revision: targetRevision.toString(),
      };
      await client.query(
        `INSERT INTO admin_operation_changes(
           id, admin_operation_id, resource_type, resource_id, before_data, after_data
         ) VALUES ($1, $2, 'ADMIN_PRINCIPAL_ROLE', $3, $4::jsonb, $5::jsonb)`,
        [
          randomUUID(),
          locked.id,
          parsed.principalId,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
           before_data, after_data, metadata, correlation_id, causation_id
         ) VALUES (
           $1, 'ADMIN', $2, 'admin.role.assign', 'ADMIN_PRINCIPAL', $3, 4, $4,
           $5::jsonb, $6::jsonb, $7::jsonb, $8, $9
         )`,
        [
          randomUUID(),
          actorPrincipalId,
          parsed.principalId,
          locked.reason,
          JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify({
            adminOperationId: locked.id,
            requestFingerprint: locked.requestFingerprint,
          }),
          locked.correlationId,
          locked.id,
        ],
      );
      const resultPayload = {
        applied: true,
        targetRevision: targetRevision.toString(),
        changed: !wasAssigned,
      };
      await client.query(
        `UPDATE admin_operations
         SET status = 'APPLIED', result = $2::jsonb, applied_at = now(),
             revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [locked.id, JSON.stringify(resultPayload)],
      );
      const final = await getOperationWithClient(client, locked.id);
      if (final === null) throw new Error("Operation disappeared after apply");
      return final;
    });
  }
}
