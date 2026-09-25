import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { AdminRewardCatalogService } from "./reward-catalog-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminService } from "./service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type {
  AdminWhatsAppNameResolution,
  AdminWhatsAppPlayerTarget,
} from "../../platform/admin/postgres-admin-whatsapp-player-target-resolver.js";
import type { AdminBatchWhatsAppPreviewRef } from "../../platform/admin/postgres-admin-batch-whatsapp-preview-ref-repository.js";

interface AdminIdentityResolver {
  resolvePrincipal(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<{ readonly principalId: string } | null>;
  capabilitiesFor(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<readonly string[]>;
}

interface PlayerTargetResolver {
  resolveExternalRefs(
    provider: string,
    externalRefs: readonly string[],
  ): Promise<readonly AdminWhatsAppPlayerTarget[]>;
  resolveTrainerName(name: string): Promise<AdminWhatsAppNameResolution>;
}

interface PreviewRefReader {
  findByProviderMessage(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
  }): Promise<AdminBatchWhatsAppPreviewRef | null>;
}

export interface AdminWhatsAppBatchDependencies {
  readonly admins: AdminIdentityResolver;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly targets: PlayerTargetResolver;
  readonly catalog: Pick<AdminRewardCatalogService, "get">;
  readonly admin: Pick<AdminService, "prepareMutation" | "apply" | "confirm">;
  readonly previewRefs: PreviewRefReader;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly handler: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.handler(context);
  }
}

interface ResolvedAdmin {
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

interface ParsedAdminAction {
  readonly kind: "PROGRESSION" | "WALLET" | "ITEM" | "POKEDEX_SEEN";
  readonly label: string;
  readonly delta: string | null;
  readonly catalogQuery: string | null;
  readonly targetText: string;
  readonly reason: string;
}

interface PreviewResult {
  readonly batchId: string;
  readonly targetCount: number;
  readonly revision: string;
}

interface ExecutionResult {
  readonly targetCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly failures: readonly Record<string, unknown>[];
}

function normalize(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function adminIdentity(context: MessageHandlerContext) {
  return {
    provider: context.message.provider,
    externalId: context.message.senderRef,
  };
}

async function resolveAdmin(
  dependencies: AdminWhatsAppBatchDependencies,
  context: MessageHandlerContext,
): Promise<Result<ResolvedAdmin>> {
  const identity = adminIdentity(context);
  const principal = await dependencies.admins.resolvePrincipal(identity);
  if (principal === null) {
    return err(
      appError("FORBIDDEN", "Administrative WhatsApp identity was not found", {
        userMessage: "Este comando é restrito à equipe administrativa.",
      }),
    );
  }
  const capabilities = await dependencies.admins.capabilitiesFor(identity);
  if (!capabilities.includes("central.view")) {
    return err(
      appError("FORBIDDEN", "Administrative Central access capability is denied", {
        userMessage: "Seu acesso administrativo não inclui a Central ADM.",
      }),
    );
  }
  return ok({ principalId: principal.principalId, capabilities });
}

function commandBody(context: MessageHandlerContext): string {
  const text = context.message.text?.trim() ?? "";
  const firstSpace = text.indexOf(" ");
  return firstSpace < 0 ? "" : text.slice(firstSpace + 1).trim();
}

function textResult(
  context: MessageHandlerContext,
  text: string,
  payloadExtra: Readonly<Record<string, unknown>> = {},
  suffix = "reply",
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text, ...payloadExtra },
        idempotencyKey: `${context.idempotencyKey}:admin:${suffix}`,
      },
    ],
  });
}

function menu(capabilities: readonly string[]): string {
  const lines = [
    "〔◆〕 *CENTRAL ADM · WHATSAPP*",
    "",
    "As ações abaixo usam o mesmo motor auditado da Central.",
    "",
  ];
  if (capabilities.includes("wallet.adjust")) {
    lines.push("• `/adm dinheiro +500 para @jogador | motivo`");
  }
  if (capabilities.includes("progression.adjust")) {
    lines.push("• `/adm xp +50 para @jogador | motivo`");
  }
  if (capabilities.includes("inventory.adjust")) {
    lines.push("• `/adm item potion +2 para @jogador | motivo`");
  }
  if (capabilities.includes("pokedex.seen.grant")) {
    lines.push("• `/adm visto Pikachu para @jogador | motivo`");
  }
  lines.push(
    "",
    "Pode mencionar vários jogadores ou separar nomes por vírgula.",
    "O bot sempre mostra um *preview* primeiro.",
    "Para executar, responda ao preview com `/adm confirmar`.",
  );
  return lines.join("\n");
}

function splitReason(body: string): { readonly command: string; readonly reason: string } | null {
  const pipe = body.lastIndexOf("|");
  if (pipe < 0) return null;
  const command = body.slice(0, pipe).trim();
  const reason = body.slice(pipe + 1).trim().replace(/^motivo\s*:\s*/i, "");
  if (command.length === 0 || reason.length === 0) return null;
  return { command, reason };
}

function splitTargets(command: string): { readonly action: string; readonly targetText: string } | null {
  const match = /\s+para\s+/i.exec(command);
  if (match === null || match.index <= 0) return null;
  const action = command.slice(0, match.index).trim();
  const targetText = command.slice(match.index + match[0].length).trim();
  return action.length === 0 || targetText.length === 0 ? null : { action, targetText };
}

function signedDelta(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[+-]?[1-9][0-9]*$/.test(trimmed)) return null;
  return trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
}

function parseAction(body: string): ParsedAdminAction | null {
  const withReason = splitReason(body);
  if (withReason === null) return null;
  const targeted = splitTargets(withReason.command);
  if (targeted === null) return null;

  const words = targeted.action.split(/\s+/);
  const command = normalize(words[0] ?? "");
  if (command === "dinheiro" || command === "pokedollar" || command === "moeda") {
    const delta = signedDelta(words[1] ?? "");
    if (delta === null || words.length !== 2) return null;
    return {
      kind: "WALLET",
      label: "PokéDollar",
      delta,
      catalogQuery: "pokedollar",
      targetText: targeted.targetText,
      reason: withReason.reason,
    };
  }
  if (command === "xp" || command === "progresso" || command === "progressao") {
    const delta = signedDelta(words[1] ?? "");
    if (delta === null || words.length !== 2) return null;
    return {
      kind: "PROGRESSION",
      label: "Progressão",
      delta,
      catalogQuery: null,
      targetText: targeted.targetText,
      reason: withReason.reason,
    };
  }
  if (command === "item" || command === "itens") {
    const remaining = words.slice(1);
    const deltaIndex = remaining.findIndex((word) => signedDelta(word) !== null);
    if (deltaIndex < 0) return null;
    const rawDelta = remaining[deltaIndex];
    const delta = rawDelta === undefined ? null : signedDelta(rawDelta);
    const itemQuery = remaining.filter((_, index) => index !== deltaIndex).join(" ").trim();
    if (delta === null || itemQuery.length === 0) return null;
    return {
      kind: "ITEM",
      label: itemQuery,
      delta,
      catalogQuery: itemQuery,
      targetText: targeted.targetText,
      reason: withReason.reason,
    };
  }
  if (command === "visto" || command === "ver") {
    const speciesQuery = words.slice(1).join(" ").trim();
    if (speciesQuery.length === 0) return null;
    return {
      kind: "POKEDEX_SEEN",
      label: speciesQuery,
      delta: null,
      catalogQuery: speciesQuery,
      targetText: targeted.targetText,
      reason: withReason.reason,
    };
  }
  return null;
}

function targetNames(value: string): readonly string[] {
  const withoutMentions = value
    .split(/\s+/)
    .filter((token) => !token.startsWith("@"))
    .join(" ")
    .trim();
  if (withoutMentions.length === 0) return [];
  return withoutMentions
    .split(/\s*(?:,|;|\be\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

async function resolveTargets(
  dependencies: AdminWhatsAppBatchDependencies,
  context: MessageHandlerContext,
  targetText: string,
): Promise<Result<readonly AdminWhatsAppPlayerTarget[]>> {
  const targets = new Map<string, AdminWhatsAppPlayerTarget>();
  const mentions = context.message.mentions ?? [];
  if (mentions.length > 0) {
    const mentioned = await dependencies.targets.resolveExternalRefs(
      context.message.provider,
      mentions,
    );
    for (const target of mentioned) targets.set(target.playerId, target);
    if (mentioned.length !== new Set(mentions).size) {
      return err(
        appError("NOT_FOUND", "One or more mentioned players were not found", {
          userMessage: "Não consegui localizar todos os jogadores mencionados.",
        }),
      );
    }
  }

  for (const name of targetNames(targetText)) {
    const resolved = await dependencies.targets.resolveTrainerName(name);
    if (resolved.status === "MISSING") {
      return err(
        appError("NOT_FOUND", "Admin target trainer name was not found", {
          userMessage: `Não encontrei o treinador “${name}”.`,
        }),
      );
    }
    if (resolved.status === "AMBIGUOUS") {
      const options = (resolved.candidates ?? []).map((target) => target.trainerName).slice(0, 4);
      return err(
        appError("VALIDATION_FAILED", "Admin target trainer name is ambiguous", {
          userMessage: `“${name}” ficou ambíguo. Resultados: ${options.join(", ")}. Use o nome completo ou mencione a pessoa.`,
        }),
      );
    }
    if (resolved.target !== undefined) targets.set(resolved.target.playerId, resolved.target);
  }

  if (targets.size === 0) {
    return err(
      appError("VALIDATION_FAILED", "Admin batch requires at least one target", {
        userMessage: "Informe pelo menos um jogador depois de “para”.",
      }),
    );
  }
  return ok([...targets.values()]);
}

function requiredPower(action: ParsedAdminAction): string {
  if (action.kind === "WALLET") return "wallet.adjust";
  if (action.kind === "PROGRESSION") return "progression.adjust";
  if (action.kind === "ITEM") return "inventory.adjust";
  return "pokedex.seen.grant";
}

function ensurePowers(admin: ResolvedAdmin, action: ParsedAdminAction): Result<void> {
  const required = [
    "player.read",
    "batch.preview",
    "batch.execute.low_risk",
    requiredPower(action),
  ];
  if (action.kind === "WALLET") required.push("economy.read");
  if (action.kind === "ITEM") required.push("inventory.read");
  if (action.kind === "POKEDEX_SEEN") required.push("pokedex.read");
  const missing = required.filter((capability) => !admin.capabilities.includes(capability));
  return missing.length === 0
    ? ok(undefined)
    : err(
        appError("FORBIDDEN", "Administrative capability denied", {
          userMessage: "Seu perfil administrativo não possui todos os poderes necessários para esta ação.",
        }),
      );
}

function chooseCatalogEntry<T extends { readonly slug: string; readonly displayName: string }>(
  entries: readonly T[],
  query: string,
): T | null {
  const key = normalize(query);
  const exact = entries.filter(
    (entry) => normalize(entry.slug) === key || normalize(entry.displayName) === key,
  );
  if (exact.length === 1) return exact[0] ?? null;
  const prefix = entries.filter(
    (entry) => normalize(entry.slug).startsWith(key) || normalize(entry.displayName).startsWith(key),
  );
  return prefix.length === 1 ? (prefix[0] ?? null) : null;
}

function parsePreviewResult(result: Readonly<Record<string, unknown>> | null): PreviewResult | null {
  if (
    result === null ||
    typeof result.batchId !== "string" ||
    typeof result.targetCount !== "number" ||
    !Number.isSafeInteger(result.targetCount) ||
    typeof result.revision !== "string" ||
    !/^\d+$/.test(result.revision)
  ) {
    return null;
  }
  return { batchId: result.batchId, targetCount: result.targetCount, revision: result.revision };
}

function parseExecutionResult(
  result: Readonly<Record<string, unknown>> | null,
): ExecutionResult | null {
  if (
    result === null ||
    typeof result.targetCount !== "number" ||
    typeof result.successCount !== "number" ||
    typeof result.failureCount !== "number" ||
    !Array.isArray(result.failures)
  ) {
    return null;
  }
  return {
    targetCount: result.targetCount,
    successCount: result.successCount,
    failureCount: result.failureCount,
    failures: result.failures.filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    ),
  };
}

function adminFailure(error: unknown): Result<never> {
  if (error instanceof AdminError) {
    const forbidden =
      error.code === ADMIN_ERROR_CODES.AUTHORIZATION_DENIED ||
      error.code === ADMIN_ERROR_CODES.PRINCIPAL_DISABLED ||
      error.code === ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND;
    return err(
      appError(forbidden ? "FORBIDDEN" : "ACTION_INVALID", "Administrative action rejected", {
        adminCode: error.code,
        userMessage: forbidden
          ? "Seu perfil administrativo não possui permissão para esta ação."
          : `A operação administrativa foi rejeitada: ${error.code}.`,
      }),
    );
  }
  throw error;
}

function failureSummary(failures: readonly Record<string, unknown>[]): string {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const code = typeof failure.errorCode === "string" ? failure.errorCode : "UNKNOWN";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => `${code} ×${count}`).join(" · ");
}

export function createAdminBatchWhatsAppRoutes(
  dependencies: AdminWhatsAppBatchDependencies,
): readonly CommandRouteDefinition[] {
  const adminCommand: Handler = async (context) => {
    const resolvedAdmin = await resolveAdmin(dependencies, context);
    if (!resolvedAdmin.ok) return resolvedAdmin;
    const admin = resolvedAdmin.value;
    const body = commandBody(context);

    if (body.length === 0 || normalize(body) === "menu" || normalize(body) === "ajuda") {
      return textResult(context, menu(admin.capabilities), {}, "menu");
    }

    if (normalize(body) === "confirmar") {
      const replied = context.message.replyToExternalMessageId;
      if (replied === null) {
        return err(
          appError("VALIDATION_FAILED", "Admin confirmation must reply to its preview", {
            userMessage: "Responda diretamente ao preview que deseja executar com `/adm confirmar`.",
          }),
        );
      }
      const ref = await dependencies.previewRefs.findByProviderMessage({
        provider: context.message.provider,
        providerExternalMessageId: replied,
      });
      if (
        ref === null ||
        ref.adminPrincipalId !== admin.principalId ||
        ref.chatRef !== context.message.chatRef
      ) {
        return err(
          appError("NOT_FOUND", "Admin batch preview reply anchor was not found", {
            userMessage: "Esse preview não pertence a você ou não está disponível neste grupo.",
          }),
        );
      }
      try {
        const prepared = await dependencies.admin.prepareMutation({
          principalId: admin.principalId,
          operationType: "batch.execute.low_risk",
          input: { batchId: ref.batchId },
          reason: ref.reason,
          expectedRevision: BigInt(ref.batchRevision),
          idempotencyKey: `whatsapp-admin-batch-execute:${ref.batchId}`,
          correlationId: context.correlationId,
        });
        const confirmed = await dependencies.admin.confirm(prepared.operation.id, admin.principalId);
        const operation =
          confirmed.status === "READY"
            ? await dependencies.admin.apply(confirmed.id, admin.principalId)
            : confirmed;
        const result = parseExecutionResult(operation.result);
        if (operation.status !== "APPLIED" || result === null) {
          return err(
            appError("ACTION_INVALID", "Admin batch execution did not reach APPLIED", {
              userMessage: "O lote não chegou ao estado aplicado. Nada será presumido como concluído.",
            }),
          );
        }
        const summary =
          result.failureCount === 0
            ? `✅ *LOTE APLICADO*\n\n${result.successCount}/${result.targetCount} jogadores atualizados.`
            : [
                "⚠️ *LOTE CONCLUÍDO COM FALHAS*",
                "",
                `${result.successCount} sucesso(s) · ${result.failureCount} falha(s)`,
                failureSummary(result.failures),
              ].join("\n");
        return textResult(context, summary, {}, "execute");
      } catch (error) {
        return adminFailure(error);
      }
    }

    const parsed = parseAction(body);
    if (parsed === null) {
      return err(
        appError("VALIDATION_FAILED", "Invalid admin WhatsApp command", {
          userMessage: [
            "Não entendi essa ação administrativa.",
            "",
            "Exemplos:",
            "`/adm dinheiro +500 para @jogador | evento`",
            "`/adm xp +50 para Ana, Bia | cena aprovada`",
            "`/adm item potion +2 para @jogador | recompensa`",
            "`/adm visto Pikachu para @jogador | encontro manual`",
          ].join("\n"),
        }),
      );
    }

    const powers = ensurePowers(admin, parsed);
    if (!powers.ok) return powers;
    const targets = await resolveTargets(dependencies, context, parsed.targetText);
    if (!targets.ok) return targets;

    let action: Readonly<Record<string, unknown>>;
    let actionLabel = parsed.label;
    try {
      if (parsed.kind === "PROGRESSION") {
        action = { kind: "TRAINER_PROGRESSION_ADJUST", delta: parsed.delta };
      } else if (parsed.kind === "WALLET") {
        const catalog = await dependencies.catalog.get(admin.principalId, {
          items: false,
          currencies: true,
          species: false,
        });
        const currency = chooseCatalogEntry(catalog.currencies, parsed.catalogQuery ?? "pokedollar");
        if (currency === null) {
          return err(
            appError("NOT_FOUND", "Canonical admin currency was not found", {
              userMessage: "Não consegui resolver a moeda PokéDollar do catálogo atual.",
            }),
          );
        }
        actionLabel = currency.displayName;
        action = { kind: "WALLET_ADJUST", currencyId: currency.currencyId, delta: parsed.delta };
      } else if (parsed.kind === "ITEM") {
        const catalog = await dependencies.catalog.get(admin.principalId, {
          items: true,
          currencies: false,
          species: false,
        });
        const item = chooseCatalogEntry(catalog.items, parsed.catalogQuery ?? "");
        if (item === null) {
          return err(
            appError("NOT_FOUND", "Admin item catalog query was ambiguous or missing", {
              userMessage: `Não consegui resolver o item “${parsed.catalogQuery ?? ""}”. Use o nome completo.`,
            }),
          );
        }
        actionLabel = item.displayName;
        action = { kind: "INVENTORY_ADJUST", itemId: item.itemId, delta: parsed.delta };
      } else {
        const catalog = await dependencies.catalog.get(admin.principalId, {
          items: false,
          currencies: false,
          species: true,
        });
        const query = parsed.catalogQuery ?? "";
        const nationalDex = /^#?[0-9]+$/.test(query) ? Number(query.replace(/^#/, "")) : null;
        const species =
          nationalDex === null
            ? chooseCatalogEntry(catalog.species ?? [], query)
            : (catalog.species ?? []).find((entry) => entry.nationalDex === nationalDex) ?? null;
        if (species === null) {
          return err(
            appError("NOT_FOUND", "Admin Pokedex species query was ambiguous or missing", {
              userMessage: `Não consegui resolver a espécie “${query}”. Use nome ou Nº da Pokédex.`,
            }),
          );
        }
        actionLabel = species.displayName;
        action = { kind: "POKEDEX_SEEN_GRANT", speciesId: species.speciesId, shiny: false };
      }

      const prepared = await dependencies.admin.prepareMutation({
        principalId: admin.principalId,
        operationType: "batch.preview",
        input: {
          selector: {
            kind: "PLAYER_IDS",
            playerIds: targets.value.map((target) => target.playerId),
          },
          action,
          chunkSize: 25,
        },
        reason: parsed.reason,
        idempotencyKey: `whatsapp-admin-batch-preview:${context.inboxMessageId}`,
        correlationId: context.correlationId,
      });
      const applied = await dependencies.admin.apply(prepared.operation.id, admin.principalId);
      const preview = parsePreviewResult(applied.result);
      if (applied.status !== "APPLIED" || preview === null) {
        return err(
          appError("ACTION_INVALID", "Admin batch preview did not reach APPLIED", {
            userMessage: "Não foi possível congelar o preview. Nenhuma alteração foi aplicada.",
          }),
        );
      }

      const targetLines = targets.value
        .slice(0, 20)
        .map((target) => `• ${target.trainerName}`);
      if (targets.value.length > 20) {
        targetLines.push(`• … +${targets.value.length - 20} jogador(es)`);
      }
      const effect =
        parsed.kind === "POKEDEX_SEEN"
          ? `VISTO · ${actionLabel}`
          : `${parsed.delta ?? ""} · ${actionLabel}`;
      return textResult(
        context,
        [
          "〔▣〕 *PREVIEW ADMINISTRATIVO*",
          "",
          `*Ação:* ${effect}`,
          `*Alvos:* ${preview.targetCount}`,
          ...targetLines,
          "",
          `*Motivo:* ${parsed.reason}`,
          "",
          "Nada foi aplicado ainda.",
          "Responda *a esta mensagem* com `/adm confirmar` para executar.",
        ].join("\n"),
        {
          adminBatchPreview: {
            adminPrincipalId: admin.principalId,
            batchId: preview.batchId,
            batchRevision: preview.revision,
          },
        },
        "preview",
      );
    } catch (error) {
      return adminFailure(error);
    }
  };

  return [
    {
      command: "adm",
      aliases: ["admin"],
      handler: new FunctionalHandler(adminCommand),
      rateLimitClass: "SENSITIVE",
    },
  ];
}
