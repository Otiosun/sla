import { ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { HubLoginTicketService } from "./login-ticket-service.js";

export interface HubWhatsAppDependencies {
  readonly tickets: Pick<HubLoginTicketService, "issue">;
  readonly publicUrl: string | null;
}

class HubLoginHandler implements MessageRouteHandler {
  public constructor(private readonly dependencies: HubWhatsAppDependencies) {}

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    if (isGroupChat(context.message.chatRef)) {
      return textResult(
        context,
        ["🔒 *Seu acesso ao site é privado.*", "", "Me chama no PV e use */site* por lá."].join(
          "\n",
        ),
      );
    }

    if (this.dependencies.publicUrl === null) {
      return textResult(
        context,
        "⚠️ *Pokémon Hub indisponível no momento.*\n\nTente novamente mais tarde.",
      );
    }

    const issued = await this.dependencies.tickets.issue({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!issued.ok) return issued;

    const url = hubLoginUrl(this.dependencies.publicUrl, issued.value.ticket);
    return scheduledPrivateSiteResult(
      context,
      [
        "📟 *ROTOM · SITE*",
        "",
        "Seu acesso pessoal está pronto:",
        url,
        "",
        "_Este link expira em 5 minutos e só pode ser usado uma vez._",
      ].join("\n"),
      5_000,
    );
  }
}

function hubLoginUrl(publicUrl: string, ticket: string): string {
  const url = new URL(publicUrl);
  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragment = new URLSearchParams(rawHash);
  fragment.set("hub_ticket", ticket);
  url.hash = fragment.toString();
  return url.toString();
}

function isGroupChat(chatRef: string): boolean {
  return chatRef.endsWith("@g.us");
}

function textResult(context: MessageHandlerContext, text: string): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:reply`,
      },
    ],
  });
}

function scheduledPrivateSiteResult(
  context: MessageHandlerContext,
  text: string,
  typingMs: number,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "PRESENCE",
        payload: { state: "composing" },
        idempotencyKey: `${context.idempotencyKey}:typing`,
      },
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text, clearTyping: true },
        idempotencyKey: `${context.idempotencyKey}:reply`,
        delayMs: typingMs,
      },
    ],
  });
}

export function createHubWhatsAppRoutes(
  dependencies: HubWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  return [
    {
      command: "site",
      handler: new HubLoginHandler(dependencies),
      rateLimitClass: "SENSITIVE",
      policy: {
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    },
  ];
}
