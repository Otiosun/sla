import { createHash } from "node:crypto";
import { z } from "zod";
import { appError, err, ok } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "../admin/contracts.js";
import { AdminError } from "../admin/errors.js";
import { type AdminOperationRegistry, defineAdminOperation } from "../admin/operation-registry.js";
import type { AdminService } from "../admin/service.js";
import type { CommunityService } from "../community/service.js";
import type { CommandRouteDefinition } from "../messaging/router.js";

export const PvpGroupTimingInput = z
  .object({ groupId: z.string().uuid(), turnTtlMs: z.number().int().positive().safe() })
  .strict();
export type PvpGroupTimingInput = z.infer<typeof PvpGroupTimingInput>;
export interface PvpGroupTimingApply {
  apply(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: PvpGroupTimingInput,
  ): Promise<AdminOperationRecord>;
}
export function registerPvpGroupTiming(
  registry: AdminOperationRegistry,
  port: PvpGroupTimingApply,
) {
  registry.register(
    defineAdminOperation<PvpGroupTimingInput>({
      kind: "MUTATION",
      operationType: "community.group.pvp_timing",
      capabilityKey: "community.group.manage",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: true,
        requiresSimulation: false,
        requiresConfirmation: false,
        requiredApprovals: 0,
      },
      inputSchema: PvpGroupTimingInput,
      target: (input) => ({ type: "COMMUNITY_GROUP", id: input.groupId }),
      apply: (context, input) => port.apply(context.operation, context.actorPrincipalId, input),
    }),
  );
}
/** Candidate operational copy; no editorial approval is inferred. */
export function createPvpGroupTimingRoute(deps: {
  admins: {
    resolvePrincipal(input: {
      provider: string;
      externalId: string;
    }): Promise<{ principalId: string } | null>;
  };
  admin: Pick<AdminService, "prepareMutation" | "apply">;
  operationForKey: (key: string) => Promise<AdminOperationRecord | null>;
  community: Pick<CommunityService, "getGroupConfigurationByProviderRef">;
}): CommandRouteDefinition {
  return {
    command: "pvp",
    rateLimitClass: "SENSITIVE",
    handler: {
      handle: async (context) => {
        const match = /^\/pvp\s+prazo\s+(\d+(?:[.,]\d+)?)\s*$/iu.exec(context.message.text ?? "");
        const hours = match ? Number(match[1]!.replace(",", ".")) : NaN;
        const ttl = hours * 3600000;
        if (
          !Number.isSafeInteger(ttl) ||
          ttl <= 0 ||
          !Number.isFinite(new Date(Date.now() + ttl).getTime())
        )
          return err(
            appError("VALIDATION_FAILED", "Use /pvp prazo <horas>, com um prazo positivo."),
          );
        const principal = await deps.admins.resolvePrincipal({
          provider: context.message.provider,
          externalId: context.message.senderRef,
        });
        if (!principal)
          return err(
            appError(
              "PLAYER_INELIGIBLE",
              "Somente a administração autorizada pode configurar o prazo.",
            ),
          );
        const group = await deps.community.getGroupConfigurationByProviderRef({
          provider: context.message.provider,
          chatRef: context.message.chatRef,
        });
        if (!group || group.status !== "ACTIVE" || !group.capabilities.includes("pvp"))
          return err(
            appError("FLOW_BLOCKED", "Use este comando em um grupo ativo autorizado para PvP."),
          );
        try {
          const key =
            "pvp-timing:" + createHash("sha256").update(context.idempotencyKey).digest("hex");
          const previous = await deps.operationForKey(key);
          if (
            previous &&
            (previous.principalId !== principal.principalId ||
              previous.operationType !== "community.group.pvp_timing" ||
              previous.input.groupId !== group.id ||
              previous.input.turnTtlMs !== ttl)
          )
            return err(appError("FINGERPRINT_MISMATCH", "A configuração retransmitida mudou."));
          const operation =
            previous ??
            (
              await deps.admin.prepareMutation({
                principalId: principal.principalId,
                operationType: "community.group.pvp_timing",
                input: { groupId: group.id, turnTtlMs: ttl },
                reason: "Configuração explícita do prazo PvP no grupo de origem",
                expectedRevision: BigInt(group.revision),
                idempotencyKey: key,
                correlationId: context.correlationId,
              })
            ).operation;
          await deps.admin.apply(operation.id, principal.principalId);
        } catch (error) {
          if (error instanceof AdminError)
            return err(
              appError(
                "FLOW_BLOCKED",
                "A configuração não foi autorizada ou o grupo mudou. Consulte a administração.",
                { adminCode: error.code },
              ),
            );
          throw error;
        }
        return ok({
          resultRefType: "COMMUNITY_GROUP",
          resultRefId: group.id,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: {
                text:
                  "◇ *𝗣𝗥𝗔𝗭𝗢 𝗣𝗩𝗣*\n\nPrazo configurado: `" +
                  hours +
                  "h`.\nVálido para os próximos turnos. Os prazos já abertos continuam iguais.",
              },
              idempotencyKey: context.idempotencyKey + ":pvp-timing",
            },
          ],
        });
      },
    },
  };
}
