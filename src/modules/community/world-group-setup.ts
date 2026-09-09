import { createHash } from "node:crypto";
import { z } from "zod";
import { appError, err, ok } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "../admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import { type AdminOperationRegistry, defineAdminOperation } from "../admin/operation-registry.js";
import type { AdminService } from "../admin/service.js";
import type { CommandRouteDefinition } from "../messaging/router.js";

export const WorldGroupSetupInputSchema = z
  .object({
    provider: z.enum(["baileys", "whatsapp"]),
    chatRef: z.string().regex(/^\d+(?:-\d+)?@g\.us$/),
    displayName: z.string().trim().min(1).max(120),
    sourceChannel: z.literal("WHATSAPP"),
  })
  .strict();
export type WorldGroupSetupInput = z.infer<typeof WorldGroupSetupInputSchema>;
export const WorldGroupSetupResultSchema = z.object({
  groupId: z.string().uuid(),
  displayName: z.string(),
});
export type WorldGroupSetupResult = z.infer<typeof WorldGroupSetupResultSchema>;

export interface WorldGroupSetupPort {
  apply(operation: AdminOperationRecord): Promise<WorldGroupSetupResult>;
}

export function registerWorldGroupSetupOperation(registry: AdminOperationRegistry): void {
  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "community.group.enable_world",
      capabilityKey: "community.group.manage",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      // Additive setup is serialized by chat identity; no client revision is needed.
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: false,
        requiresConfirmation: false,
        requiredApprovals: 0,
      },
      inputSchema: WorldGroupSetupInputSchema,
      target: () => ({ type: "COMMUNITY_GROUP", id: null }),
    }),
  );
}

export function createWorldGroupSetupRoute(dependencies: {
  readonly admins: {
    resolvePrincipal(input: {
      provider: string;
      externalId: string;
    }): Promise<{ principalId: string } | null>;
  };
  readonly admin: Pick<AdminService, "prepareMutation">;
  readonly setup: WorldGroupSetupPort;
}): CommandRouteDefinition {
  return {
    command: "grupo",
    rateLimitClass: "SENSITIVE",
    // Bootstrap must work before group registration. The handler uses the full
    // AdminService GLOBAL_ONLY boundary instead of the known-group gameplay gate.
    handler: {
      handle: async (context) => {
        const match = /^[$/]grupo\s+jogo\s+([^\r\n]+)$/iu.exec(context.message.text?.trim() ?? "");
        const input = WorldGroupSetupInputSchema.safeParse({
          provider: context.message.provider,
          chatRef: context.message.chatRef,
          displayName: match?.[1],
          sourceChannel: "WHATSAPP",
        });
        if (!input.success)
          return err(
            appError(
              "VALIDATION_FAILED",
              "Envie /grupo jogo Nome do grupo dentro do grupo que deseja habilitar.",
            ),
          );
        const principal = await dependencies.admins.resolvePrincipal({
          provider: context.message.provider,
          externalId: context.message.senderRef,
        });
        if (principal === null)
          return err(
            appError(
              "PLAYER_INELIGIBLE",
              "Somente um administrador autorizado do RPG pode configurar grupos.",
            ),
          );
        try {
          const prepared = await dependencies.admin.prepareMutation({
            principalId: principal.principalId,
            operationType: "community.group.enable_world",
            input: input.data,
            reason: "Habilitar grupo de jogo por comando explícito do administrador no WhatsApp",
            idempotencyKey: `world-group:${createHash("sha256").update(context.idempotencyKey).digest("hex")}`,
            correlationId: context.correlationId,
          });
          const result = await dependencies.setup.apply(prepared.operation);
          return ok({
            resultRefType: "COMMUNITY_GROUP",
            resultRefId: result.groupId,
            outgoing: [
              {
                channel: "whatsapp",
                destinationRef: context.message.chatRef,
                messageType: "TEXT",
                payload: {
                  text: `*Grupo de jogo habilitado*\n${result.displayName}\n\nExploração e serviços do mundo estão disponíveis para treinadores aprovados.`,
                },
                idempotencyKey: `${context.idempotencyKey}:world-group`,
              },
            ],
          });
        } catch (error) {
          if (!(error instanceof AdminError)) throw error;
          if (
            [
              ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
              ADMIN_ERROR_CODES.PRINCIPAL_DISABLED,
              ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND,
            ].some((code) => code === error.code)
          ) {
            return err(
              appError(
                "PLAYER_INELIGIBLE",
                "Sua conta não tem permissão administrativa para configurar grupos.",
              ),
            );
          }
          return err(appError("ACTION_INVALID", error.message));
        }
      },
    },
  };
}
