import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import {
  WorldGroupSetupInputSchema,
  type WorldGroupSetupPort,
  type WorldGroupSetupResult,
  WorldGroupSetupResultSchema,
} from "../../modules/community/world-group-setup.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresCommunityTransaction } from "./postgres-community-repository.js";

export class PostgresWorldGroupSetup implements WorldGroupSetupPort {
  constructor(private readonly pool: Pool) {}

  async apply(operation: AdminOperationRecord): Promise<WorldGroupSetupResult> {
    const input = WorldGroupSetupInputSchema.parse(operation.input);
    return withTransaction(this.pool, async (client) => {
      const locked = (
        await client.query<{
          status: string;
          request_fingerprint: string;
          operation_type: string;
          principal_id: string;
          result: unknown;
        }>(
          "SELECT status,request_fingerprint,operation_type,principal_id,result FROM admin_operations WHERE id=$1 FOR UPDATE",
          [operation.id],
        )
      ).rows[0];
      if (
        !locked ||
        locked.request_fingerprint !== operation.requestFingerprint ||
        locked.operation_type !== "community.group.enable_world" ||
        locked.principal_id !== operation.principalId
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "A operação de configuração mudou. Envie o comando novamente.",
        );
      }
      if (locked.status === "APPLIED") return WorldGroupSetupResultSchema.parse(locked.result);
      if (locked.status !== "READY")
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "A configuração ainda não está autorizada.",
        );
      // Serialize creation/reconfiguration, including when the group row does not exist.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `world-group:${input.provider}:${input.chatRef}`,
      ]);
      const tx = new PostgresCommunityTransaction(client);
      let group = await tx.loadGroupByProviderRef(input.provider, input.chatRef);
      if (group !== null && group.status !== "ACTIVE") {
        throw new AdminError(
          ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
          "Este grupo foi desativado. Reative-o antes de configurar seus fluxos.",
        );
      }
      if (group !== null)
        await client.query("SELECT id FROM community_groups WHERE id=$1 FOR UPDATE", [group.id]);
      // Reload after acquiring the row lock so unrelated administrative updates are preserved.
      group = await tx.loadGroupByProviderRef(input.provider, input.chatRef);
      if (group !== null && group.status !== "ACTIVE")
        throw new AdminError(
          ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
          "A configuração do grupo mudou. Envie o comando novamente.",
        );
      const beforeCapabilities = group === null ? [] : await tx.listCapabilities(group.id);
      const before = group === null ? null : { ...group, capabilities: beforeCapabilities };
      if (group === null)
        group = await tx.insertGroup({
          provider: input.provider,
          chatRef: input.chatRef,
          role: input.role ?? "GAME",
          displayName: input.displayName,
        });
      if (group === null)
        throw new AdminError(
          ADMIN_ERROR_CODES.REVISION_CONFLICT,
          "O grupo foi cadastrado simultaneamente. Envie o comando novamente.",
        );
      if (input.role === "RECEPTION" && group.role !== "RECEPTION") {
        await client.query(
          "UPDATE community_groups SET role='RECEPTION',revision=revision+1,updated_at=now() WHERE id=$1",
          [group.id],
        );
        const reloaded = await tx.loadGroupById(group.id);
        if (reloaded === null) throw new Error("Configured group disappeared");
        group = reloaded;
      }
      const receptionCapabilities =
        group.role === "RECEPTION"
          ? ["onboarding" as const, "admin.review" as const, "pve" as const, "pvp" as const]
          : [];
      const capabilities = [
        ...new Set([
          ...beforeCapabilities,
          ...receptionCapabilities,
          "player.basic" as const,
          "world" as const,
        ]),
      ].sort();
      if (capabilities.some((capability) => !beforeCapabilities.includes(capability))) {
        const updated = await tx.replaceCapabilities(group.id, capabilities, group.revision);
        if (updated === null)
          throw new AdminError(
            ADMIN_ERROR_CODES.REVISION_CONFLICT,
            "A configuração do grupo mudou. Envie o comando novamente.",
          );
        group = updated;
      }
      const after = { ...group, capabilities };
      const result = { groupId: group.id, displayName: group.displayName };
      await client.query(
        `INSERT INTO admin_operation_changes(id,admin_operation_id,resource_type,resource_id,before_data,after_data)
        VALUES ($1,$2,'COMMUNITY_GROUP',$3,$4::jsonb,$5::jsonb)`,
        [
          randomUUID(),
          operation.id,
          group.id,
          before === null ? null : JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      await client.query(
        `INSERT INTO audit_events(id,actor_type,actor_id,action,target_type,target_id,risk_tier,reason,before_data,after_data,metadata,correlation_id,causation_id)
        VALUES ($1,'ADMIN',$2,'community.group.enable_world','COMMUNITY_GROUP',$3,3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
        [
          randomUUID(),
          operation.principalId,
          group.id,
          operation.reason,
          before === null ? null : JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify({
            adminOperationId: operation.id,
            requestFingerprint: operation.requestFingerprint,
            sourceChannel: "WHATSAPP",
          }),
          operation.correlationId,
          operation.id,
        ],
      );
      await client.query(
        `UPDATE admin_operations SET status='APPLIED',result=$2::jsonb,applied_at=now(),revision=revision+1,updated_at=now() WHERE id=$1`,
        [operation.id, JSON.stringify(result)],
      );
      return result;
    });
  }
}
