import type { Pool, PoolClient } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { PvpGroupTimingApply, PvpGroupTimingInput } from "../../modules/pvp/group-timing.js";
import { completeAppliedAdminOperationWithClient } from "../admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../admin/postgres-admin-repository.js";
import { withTransaction } from "../db/transaction.js";

export async function pvpGroupTurnDuration(
  client: PoolClient,
  challengeId: string,
  fallback: number,
): Promise<number> {
  const result = await client.query<{ turn_ttl_ms: string }>(
    `SELECT t.turn_ttl_ms::text FROM inbox_messages i
     JOIN community_groups g ON g.provider=i.provider AND g.chat_ref=i.normalized_payload->>'chatRef'
     JOIN community_group_capabilities c ON c.group_id=g.id AND c.capability_key='pvp' AND c.active
     JOIN pvp_group_timing t ON t.group_id=g.id
     WHERE i.status='PROCESSED' AND i.result_ref_type='PVP' AND i.result_ref_id=$1
       AND i.normalized_payload->>'text' ~ '(^|[[:space:]])/desafiar([[:space:]]|$)'
       AND g.status='ACTIVE'
     ORDER BY i.received_at,i.id LIMIT 1`,
    [challengeId],
  );
  const duration = result.rows[0] ? Number(result.rows[0].turn_ttl_ms) : fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0)
    throw new Error("Invalid PvP group deadline duration");
  return duration;
}
export class PostgresPvpGroupTiming implements PvpGroupTimingApply {
  constructor(private readonly pool: Pool) {}
  async apply(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: PvpGroupTimingInput,
  ): Promise<AdminOperationRecord> {
    await withTransaction(this.pool, async (client) => {
      const locked = await client.query<{ status: string }>(
        "SELECT status FROM admin_operations WHERE id=$1 FOR UPDATE",
        [operation.id],
      );
      if (locked.rows[0]?.status === "APPLIED") return;
      if (locked.rows[0]?.status !== "READY")
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Operação não está pronta.",
        );
      const group = await client.query<{ revision: string; turn_ttl_ms: string | null }>(
        `SELECT g.revision::text,t.turn_ttl_ms::text FROM community_groups g
         JOIN community_group_capabilities c ON c.group_id=g.id AND c.capability_key='pvp' AND c.active
         LEFT JOIN pvp_group_timing t ON t.group_id=g.id
         WHERE g.id=$1 AND g.status='ACTIVE' FOR UPDATE OF g`,
        [input.groupId],
      );
      const before = group.rows[0];
      if (!before || BigInt(before.revision) !== operation.expectedRevision)
        throw new AdminError(
          ADMIN_ERROR_CODES.REVISION_CONFLICT,
          "O grupo mudou. Consulte a configuração atual.",
        );
      await client.query(
        `INSERT INTO pvp_group_timing(group_id,turn_ttl_ms,admin_operation_id) VALUES($1,$2,$3)
        ON CONFLICT(group_id) DO UPDATE SET turn_ttl_ms=EXCLUDED.turn_ttl_ms,admin_operation_id=EXCLUDED.admin_operation_id,updated_at=now()`,
        [input.groupId, input.turnTtlMs, operation.id],
      );
      await client.query(
        "UPDATE community_groups SET revision=revision+1,updated_at=now() WHERE id=$1",
        [input.groupId],
      );
      await completeAppliedAdminOperationWithClient(client, {
        operation,
        actorPrincipalId,
        resourceType: "COMMUNITY_GROUP",
        resourceId: input.groupId,
        beforeData: {
          turnTtlMs: before.turn_ttl_ms === null ? null : Number(before.turn_ttl_ms),
          revision: before.revision,
        },
        afterData: { turnTtlMs: input.turnTtlMs, revision: String(BigInt(before.revision) + 1n) },
        result: { groupId: input.groupId, turnTtlMs: input.turnTtlMs },
        auditMetadata: { appliesTo: "FUTURE_TURN_WINDOWS" },
      });
    });
    const result = await new PostgresAdminRepository(this.pool).getOperation(operation.id);
    if (!result) throw new Error("Applied PvP timing operation disappeared");
    return result;
  }
}
