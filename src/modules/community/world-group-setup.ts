import { createHash } from "node:crypto";
import { z } from "zod";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { AdminOperationRecord } from "../admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import { type AdminOperationRegistry, defineAdminOperation } from "../admin/operation-registry.js";
import type { AdminService } from "../admin/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { CommunityCapability, CommunityGroupRecord } from "./contracts.js";
import type { CommunityService } from "./service.js";

export const WorldGroupSetupInputSchema = z
  .object({
    provider: z.enum(["baileys", "whatsapp"]),
    chatRef: z.string().regex(/^\d+(?:-\d+)?@g\.us$/),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(["GAME", "RECEPTION"]).optional(),
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

type GroupConfiguration = CommunityGroupRecord & {
  readonly capabilities: readonly CommunityCapability[];
};

const TOGGLE_CAPABILITIES = ["world", "pve", "pvp"] as const;
type ToggleCapability = (typeof TOGGLE_CAPABILITIES)[number];

const CAPABILITY_LABELS: Readonly<Record<ToggleCapability, string>> = {
  world: "Mundo / viagem",
  pve: "Encontros e batalhas PVE",
  pvp: "Desafios PVP",
};

function reply(
  context: MessageHandlerContext,
  text: string,
  groupId: string | null = null,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: groupId === null ? null : "COMMUNITY_GROUP",
    resultRefId: groupId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:world-group-control`,
      },
    ],
  });
}

function helpText(): string {
  return [
    "🛠️ *GRUPO · CONTROLE*",
    "",
    "`/grupo status` · ver configuração atual",
    "`/grupo jogo Nome` · aplicar preset de jogo",
    "`/grupo recepcao Nome` · aplicar preset de Recepção",
    "",
    "*Módulos de jogo*",
    "`/grupo ativar pve`",
    "`/grupo desativar pve`",
    "`/grupo ativar pvp`",
    "`/grupo desativar pvp`",
    "`/grupo ativar world`",
    "`/grupo desativar world`",
    "",
    "_Recepção ativa permanece isolada de gameplay._",
  ].join("\n");
}

function statusText(group: GroupConfiguration): string {
  const capabilitySet = new Set(group.capabilities);
  const controlled = TOGGLE_CAPABILITIES.map(
    (capability) =>
      `${capabilitySet.has(capability) ? "✅" : "⬜"} *${CAPABILITY_LABELS[capability]}* · \`${capability}\``,
  );

  return [
    "🛠️ *GRUPO · STATUS*",
    "",
    `*Nome:* ${group.displayName}`,
    `*Tipo:* ${group.role}`,
    `*Estado:* ${group.status}`,
    "",
    "*Módulos:*",
    ...controlled,
    "",
    `*Capabilities ativas:* ${group.capabilities.length === 0 ? "nenhuma" : group.capabilities.map((capability) => `\`${capability}\``).join(" · ")}`,
    "",
    "_Use `/grupo` para ver os controles._",
  ].join("\n");
}

function adminError(error: unknown) {
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

  return err(
    appError("ACTION_INVALID", error.message, {
      userMessage: error.message,
    }),
  );
}

export function registerWorldGroupSetupOperation(registry: AdminOperationRegistry): void {
  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "community.group.enable_world",
      capabilityKey: "community.group.manage",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
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
  readonly admin: Pick<AdminService, "prepareMutation" | "apply">;
  readonly community: Pick<
    CommunityService,
    "getGroupConfigurationByProviderRef" | "getGroupConfiguration"
  >;
  readonly setup: WorldGroupSetupPort;
}): CommandRouteDefinition {
  return {
    command: "grupo",
    rateLimitClass: "SENSITIVE",
    handler: {
      handle: async (context) => {
        const original = (context.message.text ?? "").trim();
        const command = original.normalize("NFD").replace(/\p{M}+/gu, "");

        if (/^\/grupo\s*$/iu.test(command)) {
          return reply(context, helpText());
        }

        const statusMatch = /^\/grupo\s+status\s*$/iu.test(command);
        const toggleMatch = /^\/grupo\s+(ativar|desativar)\s+(world|pve|pvp)\s*$/iu.exec(command);
        const setupMatch = /^\/grupo\s+(jogo|recepcao)\s+([^\r\n]+)$/iu.exec(command);

        if (!statusMatch && toggleMatch === null && setupMatch === null) {
          return err(
            appError("VALIDATION_FAILED", helpText(), {
              userMessage: helpText(),
            }),
          );
        }

        const principal = await dependencies.admins.resolvePrincipal({
          provider: context.message.provider,
          externalId: context.message.senderRef,
        });
        if (principal === null) {
          return err(
            appError(
              "PLAYER_INELIGIBLE",
              "Somente um administrador autorizado do RPG pode configurar grupos.",
            ),
          );
        }

        if (statusMatch) {
          const group = await dependencies.community.getGroupConfigurationByProviderRef({
            provider: context.message.provider,
            chatRef: context.message.chatRef,
          });
          if (group === null) {
            return reply(
              context,
              [
                "🛠️ *GRUPO · STATUS*",
                "",
                "Este grupo ainda não está cadastrado no Pokémon Beyond.",
                "",
                "Use `/grupo jogo Nome` ou `/grupo recepcao Nome`.",
              ].join("\n"),
            );
          }
          return reply(context, statusText(group), group.id);
        }

        if (toggleMatch !== null) {
          const group = await dependencies.community.getGroupConfigurationByProviderRef({
            provider: context.message.provider,
            chatRef: context.message.chatRef,
          });
          if (group === null) {
            return err(
              appError("FLOW_BLOCKED", "Community group is not configured", {
                userMessage:
                  "Este grupo ainda não está configurado. Use `/grupo jogo Nome` primeiro.",
              }),
            );
          }
          if (group.status !== "ACTIVE") {
            return err(
              appError("FLOW_BLOCKED", "Community group is retired", {
                userMessage:
                  "Este grupo está desativado. Use `/grupo jogo Nome` ou `/grupo recepcao Nome` para reativá-lo.",
              }),
            );
          }
          if (group.role === "RECEPTION") {
            return err(
              appError("FLOW_BLOCKED", "Reception gameplay isolation", {
                userMessage:
                  "Uma Recepção ativa não pode receber módulos de gameplay. Converta explicitamente o grupo antes.",
              }),
            );
          }

          const enabled = toggleMatch[1]?.toLowerCase() === "ativar";
          const capability = toggleMatch[2]?.toLowerCase() as ToggleCapability;
          const current = new Set<CommunityCapability>(group.capabilities);
          const alreadyDesired = enabled ? current.has(capability) : !current.has(capability);
          if (alreadyDesired) {
            return reply(
              context,
              `${enabled ? "✓" : "○"} *${CAPABILITY_LABELS[capability]}* já estava ${enabled ? "ativado" : "desativado"}.\n\n${statusText(group)}`,
              group.id,
            );
          }

          if (enabled) current.add(capability);
          else current.delete(capability);
          const nextCapabilities = [...current].sort();

          try {
            const prepared = await dependencies.admin.prepareMutation({
              principalId: principal.principalId,
              operationType: "community.group.manage",
              input: {
                groupId: group.id,
                sourceChannel: "WHATSAPP",
                action: "REPLACE_CAPABILITIES",
                payload: { capabilities: nextCapabilities },
              },
              reason: `${enabled ? "Ativar" : "Desativar"} ${capability} por comando explícito no WhatsApp`,
              expectedRevision: BigInt(group.revision),
              idempotencyKey: `group-cap:${createHash("sha256").update(context.idempotencyKey).digest("hex")}`,
              correlationId: context.correlationId,
            });
            await dependencies.admin.apply(prepared.operation.id, principal.principalId);
          } catch (error) {
            return adminError(error);
          }

          const updated = await dependencies.community.getGroupConfiguration(group.id);
          if (updated === null) {
            return err(appError("NOT_FOUND", "Community group disappeared after update"));
          }

          return reply(
            context,
            [
              `${enabled ? "✓" : "○"} *${CAPABILITY_LABELS[capability]} ${enabled ? "ativado" : "desativado"}*`,
              "",
              statusText(updated),
            ].join("\n"),
            updated.id,
          );
        }

        const setupInput = WorldGroupSetupInputSchema.safeParse({
          provider: context.message.provider,
          chatRef: context.message.chatRef,
          displayName: original.replace(/^\S+\s+\S+\s+/u, ""),
          role: setupMatch?.[1]?.toLowerCase() === "recepcao" ? "RECEPTION" : "GAME",
          sourceChannel: "WHATSAPP",
        });
        if (!setupInput.success) {
          return err(
            appError("VALIDATION_FAILED", helpText(), {
              userMessage: helpText(),
            }),
          );
        }

        try {
          const prepared = await dependencies.admin.prepareMutation({
            principalId: principal.principalId,
            operationType: "community.group.enable_world",
            input: setupInput.data,
            reason:
              setupInput.data.role === "RECEPTION"
                ? "Configurar grupo de Recepção por comando explícito do administrador no WhatsApp"
                : "Configurar grupo de jogo por comando explícito do administrador no WhatsApp",
            idempotencyKey: `world-group:${createHash("sha256").update(context.idempotencyKey).digest("hex")}`,
            correlationId: context.correlationId,
          });
          const result = await dependencies.setup.apply(prepared.operation);
          return reply(
            context,
            `*Bot habilitado neste grupo*\n${result.displayName}\n\n${
              setupInput.data.role === "RECEPTION"
                ? "Recepção e cadastro habilitados. Este grupo fica restrito ao fluxo de registro e revisão."
                : "Exploração, encontros PVE e serviços do mundo estão disponíveis para treinadores aprovados."
            }`,
            result.groupId,
          );
        } catch (error) {
          return adminError(error);
        }
      },
    },
  };
}
