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
  readonly handler: MessageRouteHandler;
  readonly rateLimitClass?: "STANDARD" | "SENSITIVE";
}

interface RegisteredRoute {
  readonly handler: MessageRouteHandler;
  readonly rateLimitClass: "STANDARD" | "SENSITIVE";
}

function normalizeCommand(value: string): string {
  return value.trim().toLocaleLowerCase("pt-BR");
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
    const command = normalizeCommand(definition.command.replace(/^\$/, ""));
    if (command.length === 0) {
      throw new Error("Messaging command route cannot be empty");
    }
    if (this.routes.has(command)) {
      throw new Error(`Messaging command route is already registered: ${command}`);
    }
    this.routes.set(command, {
      handler: definition.handler,
      rateLimitClass: definition.rateLimitClass ?? "STANDARD",
    });
  }

  classify(message: IncomingMessage): MessageRoutingMetadata {
    const command = commandFromText(message.text);
    if (command === null) {
      return { command: null, sensitiveActionKey: null };
    }
    const route = this.routes.get(command);
    return {
      command,
      sensitiveActionKey: route?.rateLimitClass === "SENSITIVE" ? `command:${command}` : null,
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
