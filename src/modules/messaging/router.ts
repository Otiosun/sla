import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
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
}

interface RegisteredRoute {
  readonly canonicalCommand: string;
  readonly handler: MessageRouteHandler;
  readonly rateLimitClass: "STANDARD" | "SENSITIVE";
}

function normalizeCommand(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function normalizeRouteToken(value: string): string {
  return normalizeCommand(value.replace(/^\$/, ""));
}

function commandFromText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("$")) return null;
  const token = trimmed.slice(1).split(/\s+/, 1)[0]?.trim();
  return token === undefined || token.length === 0 ? null : normalizeCommand(token);
}

export class MessageRouter implements MessageRouterPort {
  private readonly routes = new Map<string, RegisteredRoute>();

  constructor(definitions: readonly CommandRouteDefinition[] = []) {
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
    };
    for (const routeKey of pendingKeys) {
      this.routes.set(routeKey, route);
    }
  }

  classify(message: IncomingMessage): MessageRoutingMetadata {
    const command = commandFromText(message.text);
    if (command === null) {
      return { command: null, sensitiveActionKey: null };
    }
    const route = this.routes.get(command);
    const canonicalCommand = route?.canonicalCommand ?? command;
    return {
      command: canonicalCommand,
      sensitiveActionKey:
        route?.rateLimitClass === "SENSITIVE" ? `command:${canonicalCommand}` : null,
    };
  }

  async dispatch(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const command = commandFromText(context.message.text);
    if (command === null) {
      return ok(null);
    }
    const route = this.routes.get(command);
    if (route === undefined) {
      return err(
        appError("ACTION_INVALID", "Unknown command", {
          command,
          correlationId: context.correlationId,
        }),
      );
    }
    return route.handler.handle(context);
  }
}
