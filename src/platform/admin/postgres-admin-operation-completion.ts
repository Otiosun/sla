import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type {
  AdminOperationCompletionPort,
  CompleteAdminOperationInput,
} from "../../modules/admin/ports.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresAdminRepository } from "./postgres-admin-repository.js";

export class PostgresAdminOperationCompletion implements AdminOperationCompletionPort {
  private readonly adminRepository: PostgresAdminRepository;

  public constructor(private readonly pool: Pool) {
    this.adminRepository = new PostgresAdminRepository(pool);
  }

  public async completeAppliedOperation(
    input: CompleteAdminOperationInput,
  ): Promise<AdminOperationRecord> {
    const alreadyApplied = await withTransaction(this.pool, async (client) => {
      const locked = await client.query<{
        status: string;
        operation_type: string;
        request_fingerprint: string;
      }>(
        `SELECT status, operation_type, request_fingerprint
         FROM admin_operations
         WHERE id = $1
         FOR UPDATE`,
        [input.operation.id],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      if (row.status === "APPLIED") return true;
      if (
        row.status !== "READY" ||
        row.operation_type !== input.operation.operationType ||
        row.request_fingerprint !== input.operation.requestFingerprint
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Admin operation changed before domain evidence completion",
        );
      }

      await client.query(
        `INSERT INTO admin_operation_changes(
           id, admin_operation_id, resource_type, resource_id, before_data, after_data
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          randomUUID(),
          input.operation.id,
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
           $1, 'ADMIN', $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10::jsonb, $11, $12
         )`,
        [
          randomUUID(),
          input.actorPrincipalId,
          input.operation.operationType,
          input.operation.targetType,
          input.operation.targetId,
          input.operation.riskTier,
          input.operation.reason,
          JSON.stringify(input.beforeData),
          JSON.stringify(input.afterData),
          JSON.stringify({
            adminOperationId: input.operation.id,
            requestFingerprint: input.operation.requestFingerprint,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
          }),
          input.operation.correlationId,
          input.operation.id,
        ],
      );
      const updated = await client.query(
        `UPDATE admin_operations
         SET status = 'APPLIED', result = $2::jsonb, applied_at = now(),
             revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status = 'READY' AND request_fingerprint = $3`,
        [input.operation.id, JSON.stringify(input.result), input.operation.requestFingerprint],
      );
      if (updated.rowCount !== 1) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Admin domain evidence completion lost operation state race",
        );
      }
      return false;
    });

    const final = await this.adminRepository.getOperation(input.operation.id);
    if (final === null) throw new Error("Admin operation disappeared after evidence completion");
    if (alreadyApplied && final.status !== "APPLIED") {
      throw new Error("Admin operation replay lost APPLIED state");
    }
    return final;
  }
}
