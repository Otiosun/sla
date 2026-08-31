import type { Pool } from "pg";
import type {
  AdminAccessSessionRepository,
  AdminAccessSessionUseDecision,
  AdminAccessSessionUseRequest,
} from "../../adapters/admin-api/access-session-guard.js";
import type { AdminAccessSessionRevocationRequest } from "../../adapters/admin-api/session-logout-service.js";

export class PostgresAdminAccessSessionRepository implements AdminAccessSessionRepository {
  public constructor(private readonly pool: Pool) {}

  public async useSession(
    request: AdminAccessSessionUseRequest,
  ): Promise<AdminAccessSessionUseDecision> {
    const result = await this.pool.query<{ status: "ACTIVE" }>(
      `WITH principal_gate AS (
         SELECT cutoff.revoked_before
         FROM admin_principals principal
         LEFT JOIN admin_access_session_revocation_cutoffs cutoff
           ON cutoff.principal_id = principal.id
          AND cutoff.environment = $3
         WHERE principal.id = $2
         FOR SHARE OF principal
       )
       INSERT INTO admin_access_sessions (
         token_fingerprint,
         principal_id,
         environment,
         status,
         access_issued_at,
         access_not_before,
         access_expires_at,
         created_at,
         last_seen_at,
         idle_expires_at
       )
       SELECT
         $1,
         $2,
         $3,
         'ACTIVE',
         $4,
         $5,
         $6,
         $7,
         $7,
         $8
       FROM principal_gate
       WHERE $7::timestamptz >= $5::timestamptz
         AND $7::timestamptz < $6::timestamptz
         AND $8::timestamptz > $7::timestamptz
         AND $8::timestamptz <= $6::timestamptz
         AND $4::timestamptz <= $6::timestamptz
         AND (
           principal_gate.revoked_before IS NULL
           OR $4::timestamptz > principal_gate.revoked_before
         )
       ON CONFLICT (token_fingerprint) DO UPDATE
       SET last_seen_at = EXCLUDED.last_seen_at,
           idle_expires_at = EXCLUDED.idle_expires_at
       WHERE admin_access_sessions.status = 'ACTIVE'
         AND admin_access_sessions.principal_id = EXCLUDED.principal_id
         AND admin_access_sessions.environment = EXCLUDED.environment
         AND admin_access_sessions.access_issued_at = EXCLUDED.access_issued_at
         AND admin_access_sessions.access_not_before = EXCLUDED.access_not_before
         AND admin_access_sessions.access_expires_at = EXCLUDED.access_expires_at
         AND admin_access_sessions.idle_expires_at > EXCLUDED.last_seen_at
         AND admin_access_sessions.access_expires_at > EXCLUDED.last_seen_at
         AND EXCLUDED.last_seen_at >= admin_access_sessions.access_not_before
         AND EXCLUDED.last_seen_at >= admin_access_sessions.last_seen_at
         AND EXCLUDED.idle_expires_at > EXCLUDED.last_seen_at
         AND EXCLUDED.idle_expires_at <= admin_access_sessions.access_expires_at
       RETURNING status`,
      [
        request.tokenFingerprint,
        request.principalId,
        request.environment,
        request.accessIssuedAt,
        request.accessNotBefore,
        request.accessExpiresAt,
        request.observedAt,
        request.idleExpiresAt,
      ],
    );

    return result.rowCount === 1 ? "ACTIVE" : "DENIED";
  }

  public async revokeSession(request: AdminAccessSessionRevocationRequest): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE admin_access_sessions
       SET status = 'REVOKED',
           revoked_at = $2,
           revoked_by_principal_id = $3,
           revocation_reason = $4
       WHERE token_fingerprint = $1
         AND status = 'ACTIVE'
       RETURNING token_fingerprint`,
      [request.tokenFingerprint, request.revokedAt, request.revokedByPrincipalId, request.reason],
    );

    return result.rowCount === 1;
  }
}
