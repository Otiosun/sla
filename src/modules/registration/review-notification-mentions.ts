import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { Result } from "../../shared-kernel/result.js";

export interface RegistrationReviewMentionSource {
  mentionsFor(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<readonly string[]>;
}

function isReviewNotification(payload: Readonly<Record<string, unknown>>): boolean {
  const anchor = payload.registrationReview;
  return typeof anchor === "object" && anchor !== null && !Array.isArray(anchor);
}

function normalizedMentions(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()))]
    .filter((value) => /^\d+@s\.whatsapp\.net$/.test(value))
    .sort();
}

function displayMention(jid: string): string {
  return `@${jid.slice(0, jid.indexOf("@"))}`;
}

class RegistrationReviewMentionHandler implements MessageRouteHandler {
  public constructor(
    private readonly delegate: MessageRouteHandler,
    private readonly mentions: RegistrationReviewMentionSource,
  ) {}

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    const result = await this.delegate.handle(context);
    if (!result.ok) return result;

    let mentionJids: readonly string[];
    try {
      mentionJids = normalizedMentions(
        await this.mentions.mentionsFor({
          provider: context.message.provider,
          chatRef: context.message.chatRef,
        }),
      );
    } catch {
      return result;
    }
    if (mentionJids.length === 0) return result;

    return {
      ok: true,
      value: {
        ...result.value,
        outgoing: result.value.outgoing.map((message) => {
          if (!isReviewNotification(message.payload)) return message;
          const text = message.payload.text;
          if (typeof text !== "string") return message;
          return {
            ...message,
            payload: {
              ...message.payload,
              text: `${text}\n\nResponsáveis: ${mentionJids.map(displayMention).join(" ")}`,
              mentions: mentionJids,
            },
          };
        }),
      },
    };
  }
}

export function withRegistrationReviewMentions(
  routes: readonly CommandRouteDefinition[],
  mentions: RegistrationReviewMentionSource,
): readonly CommandRouteDefinition[] {
  return routes.map((route) =>
    route.command === "confirmar"
      ? {
          ...route,
          handler: new RegistrationReviewMentionHandler(route.handler, mentions),
        }
      : route,
  );
}
