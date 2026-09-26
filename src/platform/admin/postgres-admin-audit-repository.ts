import type { Pool } from "pg";
import {
  AdminOperationStatusSchema,
  AdminRiskTierSchema,
} from "../../modules/admin/contracts.js";
import type { AdminAuditEntry } from "../../modules/admin/audit-contracts.js";
import type { AdminAuditRepository } from "../../modules/admin/audit-ports.js";

interface AuditRow {
  readonly operation_id: string;
  readonly operation_type: string;
  readonly actor_display_name: string | null;
  readonly target_type: string;
  readonly risk_tier: number;
  readonly status: string;
  readonly reason: string | null;
  readonly created_at: Date;
  readonly applied_at: Date | null;
}

export class PostgresAdminAuditRepository implements AdminAuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async listRecent(limit: number): Promise<readonly AdminAuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT operation.id AS operation_id,
              operation.operation_type,
              profile.trainer_name AS actor_display_name,
              operation.target_type,
              operation.risk_tier,
              operation.status,
              operation.reason,
              operation.created_at,
              operation.applied_at
       FROM admin_operations operation
       LEFT JOIN admin_principals principal ON principal.id = operation.principal_id
       LEFT JOIN LATERAL (
         SELECT player_profile.trainer_name
         FROM player_identities identity
         JOIN player_profiles player_profile ON player_profile.player_id = identity.player_id
         WHERE principal.identity_ref = 'whatsapp:' || identity.external_id
           AND identity.provider IN ('baileys', 'whatsapp')
           AND identity.status = 'ACTIVE'
         ORDER BY identity.created_at
         LIMIT 1
       ) profile ON TRUE
       ORDER BY operation.created_at DESC, operation.id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      operationId: row.operation_id,
      operationType: row.operation_type,
      actorDisplayName: row.actor_display_name?.trim() || "Administrador",
      targetType: row.target_type,
      riskTier: AdminRiskTierSchema.parse(row.risk_tier),
      status: AdminOperationStatusSchema.parse(row.status),
      reason: row.reason,
      createdAt: row.created_at.toISOString(),
      appliedAt: row.applied_at?.toISOString() ?? null,
    }));
  }
}
