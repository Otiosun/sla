import type { PlayerId } from "../../shared-kernel/ids.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type {
  ExplorationRotomPreview,
  ExpeditionRotomPreviewService,
} from "./expedition-rotom-preview.js";
import { renderExplorationRotomPreview } from "./expedition-rotom-presentation.js";

interface TrainerIdentity {
  readonly playerId: PlayerId;
  readonly state: string;
}

export interface ExplorationRotomWhatsAppDependencies {
  readonly players: {
    resolvePlayer(identity: {
      readonly provider: string;
      readonly externalId: string;
    }): Promise<Result<TrainerIdentity>>;
  };
  readonly preview: Pick<ExpeditionRotomPreviewService, "inspect">;
}

function reply(context: MessageHandlerContext, text: string): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        // Exploration state is private even when the request comes from a group.
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text },
        // The existing Inbox/Outbox will deduplicate retransmitted provider IDs.
        idempotencyKey: `${context.idempotencyKey}:exploration-preview`,
      },
    ],
  });
}

function allowedQuery(message: string | null): boolean {
  const tokens = (message ?? "").normalize("NFKC").trim().toLocaleLowerCase("pt-BR").split(/\s+/);
  return (
    tokens[0] === "/explorar" &&
    (tokens.length === 1 ||
      (tokens.length === 2 && ["status", "retomar"].includes(tokens[1] ?? "")))
  );
}

class ExplorationRotomWhatsAppHandler implements MessageRouteHandler {
  public constructor(private readonly dependencies: ExplorationRotomWhatsAppDependencies) {}

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    if (!allowedQuery(context.message.text)) {
      return reply(
        context,
        [
          "△ *𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢 · 𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔*",
          "　RotomDex · Função indisponível",
          "",
          "> _Bip! Ainda não posso realizar ações de exploração._",
          "",
          "◇ *𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔𝗥 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢*",
          "",
          "`/explorar` · Situação atual",
          "`/explorar status` · Consultar novamente",
          "`/explorar retomar` · Rever registro em andamento",
          "",
          "› _Nenhuma ação será executada._",
        ].join("\n"),
      );
    }
    const identity = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!identity.ok) return identity;
    if (identity.value.state !== "COMPLETE") {
      return reply(
        context,
        [
          "△ *𝗖𝗔𝗗𝗔𝗦𝗧𝗥𝗢 𝗣𝗘𝗡𝗗𝗘𝗡𝗧𝗘*",
          "　RotomDex · Exploração",
          "",
          "> _Bip-bip! Ainda faltam informações do treinador._",
          "",
          "› _Conclua seu cadastro antes de consultar a exploração._",
        ].join("\n"),
      );
    }

    const inspected: Result<ExplorationRotomPreview> = await this.dependencies.preview.inspect(
      identity.value.playerId,
    );
    if (!inspected.ok) return inspected;
    return reply(context, renderExplorationRotomPreview(inspected.value));
  }
}

/**
 * Staging-only read route. Register through explicit composition opt-in only
 * after the solo_expeditions draft schema and release coverage are present.
 * No first action, travel, capture or session write is exposed.
 */
export function createExplorationRotomWhatsAppRoutes(
  dependencies: ExplorationRotomWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  return [
    {
      command: "explorar",
      handler: new ExplorationRotomWhatsAppHandler(dependencies),
      rateLimitClass: "SENSITIVE",
      policy: {
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    },
  ];
}
