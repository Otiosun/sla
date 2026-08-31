import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  AdminSessionRevokeAllInputSchema,
  type AdminOperationRecord,
  type AdminSessionRevokeAllInput,
  type AdminSimulationResult,
} from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { AdminSessionRevocationPort } from "../../modules/admin/ports.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresAdminRepository } from "./postgres-admin-repository.js";

interface LockedRevocationOperation {
  status: string;
  operation_type: string;
  principal_id: string;
  target_type: string;
  target_id: string | null;
  request_fingerprint: string;
  requires_confirmation: boolean;
  required_approvals: number;
  reason: string | null;
  correlation_id: string;
  risk_tier: number;
}

export class PostgresAdminSessionRevocationPort implements AdminSessionRevocationPort {
  private readonly adminRepository: PostgresAdminRepository;

  public constructor(private readonly pool: Pool) {
    this.adminRepository = new PostgresAdminRepository(pool);
  }

  public async simulateSessionRevocation(
    input: AdminSessionRevokeAllInput,
  ): Promise<AdminSimulationResult> {
    const parsed = AdminSessionRevokeAllInputSchema.parse(input);
    const result = await this.pool.query<{
      status: string;
      revision: string;
      revoked_before: Date | null;
      active_sessions: string;
    }>(
      `SELECT principal.status,
              principal.revision::text,
              principal.admin_access_sessions_revoked_before AS revoked_before,
              count(session.token_fingerprint) FILTER (WHERE session.status = 'ACTIVE')::text
                AS active_sessions
       FROM admin_principals principal
       LEFT JOIN admin_access_sessions session ON session.principal_id = principal.id
       WHERE principal.id = $1
       GROUP BY principal.id`,
      [parsed.principalId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Target principal not found");
    }
    const activeSessions = Number(row.active_sessions);
    return {
      summary: {
        operation: "admin.session.revoke_all",
        activeSessions,
        targetRevision: row.revision,
      },
      before: {
        principalStatus: row.status,
        activeSessions,
        sessionRevocationCutoff: row.revoked_before?.toISOString() ?? null,
        revision: row.revision,
      },
      after: {
        principalStatus: row.status,
        activeSessions: 0,
        sessionRevocationCutoff: "AT_APPLY",
        revision: (BigInt(row.revision) + 1n).toString(),
      },
    };
  }

  public async applySessionRevocation(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminSessionRevokeAllInput,
  ): Promise<AdminOperationRecord> {
    const parsed = AdminSessionRevokeAllInputSchema.parse(input);
    const alreadyApplied = await withTransaction(this.pool, async (client) => {
      const operationResult = await client.query<LockedRevocationOperation>(
        `SELECT status, operation_type, principal_id, target_type, target_id,
                request_fingerprint, requires_confirmation, required_approvals,
                reason, correlation_id, risk_tier
         FROM admin_operations
         WHERE id = $1
         FOR UPDATE`,
        [operation.id],
      );
      const locked = operationResult.rows[0];
      if (locked === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      if (locked.status === "APPLIED") return true;
      if (
        locked.status !== "READY" ||
        locked.operation_type !== "admin.session.revoke_all" ||
        locked.target_type !== "ADMIN_PRINCIPAL" ||
        locked.target_id !== parsed.principalId ||
        locked.request_fingerprint !== operation.requestFingerprint
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Session revocation operation changed before apply",
        );
      }

      if (locked.requires_confirmation) {
        const confirmation = await client.query<{ ok: boolean }>(
          `SELECT EXISTS(
             SELECT 1
             FROM admin_operation_confirmations
             WHERE admin_operation_id = $1
               AND principal_id = $2
               AND request_fingerprint = $3
           ) AS ok`,
          [operation.id, locked.principal_id, locked.request_fingerprint],
        );
        if (confirmation.rows[0]?.ok !== true) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
            "Required confirmation evidence is missing",
          );
        }
      }

      if (locked.required_approvals > 0) {
        const approvals = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM admin_operation_approvals
           WHERE admin_operation_id = $1
             AND request_fingerprint = $2
             AND decision = 'APPROVED'
             AND principal_id <> $3`,
          [operation.id, locked.request_fingerprint, locked.principal_id],
        );
        if (Number(approvals.rows[0]?.count ?? "0") < locked.required_approvals) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
            "Required independent approvals are missing",
          );
        }
      }

      const targetResult = await client.query<{
        status: string;
        revision: string;
        revoked_before: Date | null;
      }>(
        `SELECT status, revision::text,
                admin_access_sessions_revoked_before AS revoked_before
         FROM admin_principals
         WHERE id = $1
         FOR UPDATE`,
        [parsed.principalId],
      );
      const target = targetResult.rows[0];
      if (target === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Target principal not found");
      }

      const activeBeforeResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM admin_access_sessions
         WHERE principal_id = $1 AND status = 'ACTIVE'`,
        [parsed.principalId],
      );
      const activeBefore = Number(activeBeforeResult.rows[0]?.count ?? "0");
      const cutoffResult = await client.query<{ cutoff: Date }>(
        "SELECT clock_timestamp() AS cutoff",
      );
      const cutoff = cutoffResult.rows[0]?.cutoff;
      if (cutoff === undefined) throw new Error("Failed to materialize session revocation cutoff");

      const principalUpdate = await client.query<{ revision: string; cutoff: Date }>(
        `UPDATE admin_principals
         SET admin_access_sessions_revoked_before = GREATEST(
               COALESCE(admin_access_sessions_revoked_before, '-infinity'::timestamptz),
               $2::timestamptz
             ),
             revision = revision + 1
         WHERE id = $1
         RETURNING revision::text, admin_access_sessions_revoked_before AS cutoff`,
        [parsed.principalId, cutoff],
      );
      const updatedPrincipal = principalUpdate.rows[0];
      if (updatedPrincipal === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Target principal not found");
      }

      const revoked = await client.query(
        `UPDATE admin_access_sessions
         SET status = 'REVOKED',
             revoked_at = $2,
             revoked_by_principal_id = $3,
             revocation_reason = 'ADMIN_REVOKE_ALL'
         WHERE principal_id = $1
           AND status = 'ACTIVE'`,
        [parsed.principalId, updatedPrincipal.cutoff, actorPrincipalId],
      );
      const revokedSessions = revoked.rowCount ?? 0;
      if (revokedSessions !== activeBefore) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Session set changed during governed revocation",
        );
      }

      const before = {
        principalStatus: target.status,
        activeSessions: activeBefore,
        sessionRevocationCutoff: target.revoked_before?.toISOString() ?? null,
        revision: target.revision,
      };
      const after = {
        principalStatus: target.status,
        activeSessions: 0,
        sessionRevocationCutoff: updatedPrincipal.cutoff.toISOString(),
        revision: updatedPrincipal.revision,
      };

      await client.query(
        `INSERT INTO admin_operation_changes(
           id, admin_operation_id, resource_type, resource_id, before_data, after_data
         ) VALUES ($1, $2, 'ADMIN_ACCESS_SESSIONS', $3, $4::jsonb, $5::jsonb)`,
        [
          randomUUID(),
          operation.id,
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
           $1, 'ADMIN', $2, 'admin.session.revoke_all', 'ADMIN_PRINCIPAL', $3, $4, $5,
           $6::jsonb, $7::jsonb, $8::jsonb, $9, $10
         )`,
        [
          randomUUID(),
          actorPrincipalId,
          parsed.principalId,
          locked.risk_tier,
          locked.reason,
          JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify({
            adminOperationId: operation.id,
            requestFingerprint: locked.request_fingerprint,
            revokedSessions,
          }),
          locked.correlation_id,
          operation.id,
        ],
      );

      const resultPayload = {
        applied: true,
        revokedSessions,
        targetRevision: updatedPrincipal.revision,
        sessionRevocationCutoff: updatedPrincipal.cutoff.toISOString(),
      };
      const operationUpdate = await client.query(
        `UPDATE admin_operations
         SET status = 'APPLIED',
             result = $2::jsonb,
             applied_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'READY'
           AND request_fingerprint = $3`,
        [operation.id, JSON.stringify(resultPayload), locked.request_fingerprint],
      );
      if (operationUpdate.rowCount !== 1) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Session revocation lost operation state race",
        );
      }
      return false;
    });

    const final = await this.adminRepository.getOperation(operation.id);
    if (final === null) throw new Error("Admin operation disappeared after session revocation");
    if (alreadyApplied && final.status !== "APPLIED") {
      throw new Error("Session revocation replay lost APPLIED state");
    }
    return final;
  }
}
