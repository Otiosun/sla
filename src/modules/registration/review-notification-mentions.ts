import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { Result } from "../../shared-kernel/result.js";

export interface RegistrationReviewMentionSource {
  mentionsFor(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<readonly string[]>;
}

export interface RegistrationReviewConversation {
  admits(message: IncomingMessage): Promise<boolean>;
  resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>>;
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

async function decorateRegistrationReviewResult(
  context: MessageHandlerContext,
  result: Result<MessageHandlerResult>,
  mentions: RegistrationReviewMentionSource,
): Promise<Result<MessageHandlerResult>> {
  if (!result.ok) return result;

  let mentionJids: readonly string[];
  try {
    mentionJids = normalizedMentions(
      await mentions.mentionsFor({
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

class RegistrationReviewMentionHandler implements MessageRouteHandler {
  public constructor(
    private readonly delegate: MessageRouteHandler,
    private readonly mentions: RegistrationReviewMentionSource,
  ) {}

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return decorateRegistrationReviewResult(
      context,
      await this.delegate.handle(context),
      this.mentions,
    );
  }
}

class RegistrationReviewMentionConversation implements RegistrationReviewConversation {
  public constructor(
    private readonly delegate: RegistrationReviewConversation,
    private readonly mentions: RegistrationReviewMentionSource,
  ) {}

  public admits(message: IncomingMessage): Promise<boolean> {
    return this.delegate.admits(message);
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const result = await this.delegate.resolve(context);
    if (!result.ok) return result;
    if (result.value === null) return result;
    return decorateRegistrationReviewResult(
      context,
      { ok: true, value: result.value },
      this.mentions,
    );
  }
}

export function withRegistrationReviewConversationMentions(
  conversation: RegistrationReviewConversation,
  mentions: RegistrationReviewMentionSource,
): RegistrationReviewConversation {
  return new RegistrationReviewMentionConversation(conversation, mentions);
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
