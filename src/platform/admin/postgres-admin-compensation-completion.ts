import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type {
  AdminCompensationCompletionPort,
  CompleteAdminCompensationInput,
} from "../../modules/admin/compensation-ports.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresAdminRepository } from "./postgres-admin-repository.js";

interface LockedOperationRow {
  readonly id: string;
  readonly status: string;
  readonly operation_type: string;
  readonly request_fingerprint: string;
}

export class PostgresAdminCompensationCompletion implements AdminCompensationCompletionPort {
  private readonly adminRepository: PostgresAdminRepository;

  public constructor(private readonly pool: Pool) {
    this.adminRepository = new PostgresAdminRepository(pool);
  }

  public async completeCompensation(
    input: CompleteAdminCompensationInput,
  ): Promise<AdminOperationRecord> {
    const replayed = await withTransaction(this.pool, async (client) => {
      const ids = [input.sourceOperation.id, input.compensationOperation.id].sort();
      const locked = await client.query<LockedOperationRow>(
        `SELECT id, status, operation_type, request_fingerprint
         FROM admin_operations
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [ids],
      );
      if (locked.rowCount !== 2) {
        throw new AdminError(
          ADMIN_ERROR_CODES.OPERATION_NOT_FOUND,
          "Source or compensation admin operation not found",
        );
      }
      const source = locked.rows.find((row) => row.id === input.sourceOperation.id);
      const compensation = locked.rows.find((row) => row.id === input.compensationOperation.id);
      if (source === undefined || compensation === undefined) {
        throw new Error("Locked compensation operations could not be resolved");
      }

      if (compensation.status === "APPLIED") {
        const relation = await client.query(
          `SELECT 1
           FROM admin_operation_compensations
           WHERE source_admin_operation_id = $1
             AND compensation_admin_operation_id = $2`,
          [input.sourceOperation.id, input.compensationOperation.id],
        );
        if (relation.rowCount === 1 && source.status === "COMPENSATED") return true;
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Applied compensation operation is missing its canonical source relation",
        );
      }

      if (
        compensation.status !== "READY" ||
        compensation.operation_type !== input.compensationOperation.operationType ||
        compensation.request_fingerprint !== input.compensationOperation.requestFingerprint
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Compensation operation changed before evidence completion",
        );
      }
      if (
        source.operation_type !== input.sourceOperation.operationType ||
        source.request_fingerprint !== input.sourceOperation.requestFingerprint
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
          "Source operation changed before compensation completion",
        );
      }
      if (source.status !== "APPLIED") {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          source.status === "COMPENSATED"
            ? "Source admin operation is already compensated"
            : "Source admin operation is no longer APPLIED",
          { sourceStatus: source.status },
        );
      }

      const existing = await client.query<{ compensation_admin_operation_id: string }>(
        `SELECT compensation_admin_operation_id
         FROM admin_operation_compensations
         WHERE source_admin_operation_id = $1`,
        [input.sourceOperation.id],
      );
      if (existing.rowCount !== 0) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Source admin operation already has a compensation relation",
          { compensationOperationId: existing.rows[0]?.compensation_admin_operation_id },
        );
      }

      await client.query(
        `INSERT INTO admin_operation_compensations(
           id, source_admin_operation_id, compensation_admin_operation_id,
           compensation_kind, created_by_admin_principal_id, correlation_id
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          input.sourceOperation.id,
          input.compensationOperation.id,
          input.compensationKind,
          input.actorPrincipalId,
          input.compensationOperation.correlationId,
        ],
      );
      await client.query(
        `INSERT INTO admin_operation_changes(
           id, admin_operation_id, resource_type, resource_id, before_data, after_data
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          randomUUID(),
          input.compensationOperation.id,
          input.resourceType,
          input.resourceId,
          JSON.stringify(input.beforeData),
          JSON.stringify(input.afterData),
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
           before_data, after_data, metadata, correlation_id, causation_id
         ) VALUES (
           $1, 'ADMIN', $2, 'admin.operation.compensate', $3, $4, $5, $6,
           $7::jsonb, $8::jsonb, $9::jsonb, $10, $11
         )`,
        [
          randomUUID(),
          input.actorPrincipalId,
          input.compensationOperation.targetType,
          input.compensationOperation.targetId,
          input.compensationOperation.riskTier,
          input.compensationOperation.reason,
          JSON.stringify(input.beforeData),
          JSON.stringify(input.afterData),
          JSON.stringify({
            adminOperationId: input.compensationOperation.id,
            requestFingerprint: input.compensationOperation.requestFingerprint,
            compensatesOperationId: input.sourceOperation.id,
            compensationKind: input.compensationKind,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
          }),
          input.compensationOperation.correlationId,
          input.compensationOperation.id,
        ],
      );

      const compensationResult = {
        ...input.result,
        compensatesOperationId: input.sourceOperation.id,
        compensationKind: input.compensationKind,
      };
      const completed = await client.query(
        `UPDATE admin_operations
         SET status = 'APPLIED', result = $2::jsonb, applied_at = now(),
             revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status = 'READY' AND request_fingerprint = $3`,
        [
          input.compensationOperation.id,
          JSON.stringify(compensationResult),
          input.compensationOperation.requestFingerprint,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Compensation evidence completion lost operation state race",
        );
      }
      const sourceUpdated = await client.query(
        `UPDATE admin_operations
         SET status = 'COMPENSATED', revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status = 'APPLIED'`,
        [input.sourceOperation.id],
      );
      if (sourceUpdated.rowCount !== 1) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Source operation state changed during compensation completion",
        );
      }
      return false;
    });

    const final = await this.adminRepository.getOperation(input.compensationOperation.id);
    if (final === null) throw new Error("Compensation operation disappeared after completion");
    if (final.status !== "APPLIED") {
      throw new Error("Compensation operation did not converge to APPLIED");
    }
    if (replayed && final.result?.compensatesOperationId !== input.sourceOperation.id) {
      throw new Error("Compensation replay converged to a different source operation");
    }
    return final;
  }
}
