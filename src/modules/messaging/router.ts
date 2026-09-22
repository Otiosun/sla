import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CommandPolicyRequirement } from "../community/command-policy.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
  MessageRoutingMetadata,
} from "./contracts.js";
import type { MessageRouteHandler, MessageRouterPort } from "./ports.js";

export interface CommandRouteDefinition {
  readonly command: string;
  readonly aliases?: readonly string[];
  readonly handler: MessageRouteHandler;
  readonly rateLimitClass?: "STANDARD" | "SENSITIVE";
  readonly policy?: CommandPolicyRequirement;
  readonly allowEmbedded?: boolean;
  readonly ackReaction?: string;
}

export interface CommandRoutePolicyGate {
  authorize(
    context: MessageHandlerContext,
    policy: CommandPolicyRequirement,
  ): Promise<Result<void>>;
}

export interface MessageConversationResolver {
  resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>>;
}

interface RegisteredRoute {
  readonly canonicalCommand: string;
  readonly handler: MessageRouteHandler;
  readonly rateLimitClass: "STANDARD" | "SENSITIVE";
  readonly policy: CommandPolicyRequirement | undefined;
  readonly allowEmbedded: boolean;
  readonly ackReaction: string | undefined;
}

interface CommandCandidate {
  readonly command: string;
  readonly commandText: string;
  readonly start: number;
  readonly embedded: boolean;
}

interface CommandMatch {
  readonly candidate: CommandCandidate;
  readonly route: RegisteredRoute | undefined;
  readonly ambiguous: boolean;
}

function normalizeCommand(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function normalizeRouteToken(value: string): string {
  return normalizeCommand(value.replace(/^\//, ""));
}

function commandCandidateAtStart(text: string | null): CommandCandidate | null {
  if (text === null) return null;
  const first = text.search(/\S/);
  if (first < 0) return null;
  const prefix = text[first];
  if (prefix !== "/") return null;

  const lineEnd = text.indexOf("\n", first);
  const commandText = text.slice(first, lineEnd < 0 ? text.length : lineEnd).trim();
  const token = commandText.slice(1).split(/\s+/, 1)[0]?.trim();
  if (token === undefined || token.length === 0) return null;

  return {
    command: normalizeCommand(token),
    commandText,
    start: first,
    embedded: false,
  };
}

function embeddedCommandCandidates(text: string | null): readonly CommandCandidate[] {
  if (text === null || text.length === 0) return [];

  const firstNonWhitespace = text.search(/\S/u);
  const candidates: CommandCandidate[] = [];
  const pattern = /(^|[\s([{'"“”‘’—–,:;!?])\/([\p{L}\p{N}_-]+)/gu;

  for (const match of text.matchAll(pattern)) {
    const boundary = match[1] ?? "";
    const rawToken = match[2] ?? "";
    const start = (match.index ?? 0) + boundary.length;
    if (start === firstNonWhitespace || rawToken.length === 0) continue;

    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(start, lineEnd < 0 ? text.length : lineEnd).trim();
    const tokenText = `/${rawToken}`;
    const afterToken = line.slice(tokenText.length);
    const commandText = /^[,.;!?)}\]]/u.test(afterToken) ? tokenText : line;

    candidates.push({
      command: normalizeCommand(rawToken),
      commandText,
      start,
      embedded: true,
    });
  }

  return candidates;
}

export class MessageRouter implements MessageRouterPort {
  private readonly routes = new Map<string, RegisteredRoute>();

  constructor(
    definitions: readonly CommandRouteDefinition[] = [],
    private readonly policyGate?: CommandRoutePolicyGate,
    private readonly conversationResolver?: MessageConversationResolver,
  ) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: CommandRouteDefinition): void {
    const canonicalCommand = normalizeRouteToken(definition.command);
    const routeKeys = [
      canonicalCommand,
      ...(definition.aliases ?? []).map((alias) => normalizeRouteToken(alias)),
    ];
    const pendingKeys = new Set<string>();

    for (const routeKey of routeKeys) {
      if (routeKey.length === 0) {
        throw new Error("Messaging command route cannot be empty");
      }
      if (pendingKeys.has(routeKey) || this.routes.has(routeKey)) {
        throw new Error(`Messaging command route is already registered: ${routeKey}`);
      }
      pendingKeys.add(routeKey);
    }

    const route: RegisteredRoute = {
      canonicalCommand,
      handler: definition.handler,
      rateLimitClass: definition.rateLimitClass ?? "STANDARD",
      policy: definition.policy,
      allowEmbedded: definition.allowEmbedded ?? false,
      ackReaction: definition.ackReaction,
    };
    for (const routeKey of pendingKeys) {
      this.routes.set(routeKey, route);
    }
  }

  private matchCommand(text: string | null): CommandMatch | null {
    const leading = commandCandidateAtStart(text);
    if (leading !== null) {
      return {
        candidate: leading,
        route: this.routes.get(leading.command),
        ambiguous: false,
      };
    }

    const embedded = embeddedCommandCandidates(text)
      .map((candidate) => ({ candidate, route: this.routes.get(candidate.command) }))
      .filter(
        (
          value,
        ): value is {
          candidate: CommandCandidate;
          route: RegisteredRoute;
        } => value.route?.allowEmbedded === true,
      );

    const firstEmbedded = embedded[0];
    if (firstEmbedded === undefined) return null;

    return {
      candidate: firstEmbedded.candidate,
      route: firstEmbedded.route,
      ambiguous: embedded.length > 1,
    };
  }

  admitsCommand(message: IncomingMessage): boolean {
    const match = this.matchCommand(message.text);
    return match?.route !== undefined;
  }

  classify(message: IncomingMessage): MessageRoutingMetadata {
    const match = this.matchCommand(message.text);
    if (match === null) {
      return { command: null, sensitiveActionKey: null };
    }

    const canonicalCommand = match.route?.canonicalCommand ?? match.candidate.command;
    return {
      command: canonicalCommand,
      sensitiveActionKey:
        match.route?.rateLimitClass === "SENSITIVE" ? `command:${canonicalCommand}` : null,
    };
  }

  async dispatch(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const match = this.matchCommand(context.message.text);
    if (match === null) {
      return this.conversationResolver?.resolve(context) ?? ok(null);
    }

    if (match.ambiguous) {
      return err(
        appError("VALIDATION_FAILED", "Use apenas um comando mecânico por mensagem.", {
          correlationId: context.correlationId,
        }),
      );
    }

    const route = match.route;
    if (route === undefined) {
      return err(
        appError("VALIDATION_FAILED", "Unknown command", {
          command: match.candidate.command,
          correlationId: context.correlationId,
          userMessage: "Comando desconhecido. Use `/menu` para ver os comandos disponíveis.",
        }),
      );
    }

    const routedContext: MessageHandlerContext = {
      ...context,
      originalMessageText: context.originalMessageText ?? context.message.text,
      message: {
        ...context.message,
        text: match.candidate.commandText,
      },
    };

    if (route.policy !== undefined) {
      if (this.policyGate === undefined) {
        return err(
          appError("ACTION_INVALID", "Protected messaging command has no policy gate", {
            command: route.canonicalCommand,
            correlationId: context.correlationId,
          }),
        );
      }
      const authorized = await this.policyGate.authorize(routedContext, route.policy);
      if (!authorized.ok) return authorized;
    }

    const handled = await route.handler.handle(routedContext);
    if (!handled.ok || route.ackReaction === undefined) return handled;

    return ok({
      ...handled.value,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "REACTION",
          payload: {
            emoji: route.ackReaction,
            targetExternalMessageId: context.message.externalMessageId,
            targetSenderRef: context.message.senderRef,
          },
          idempotencyKey: `${context.idempotencyKey}:reaction`,
        },
        ...handled.value.outgoing,
      ],
    });
  }
}
