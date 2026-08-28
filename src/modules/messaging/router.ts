import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "./contracts.js";
import type { MessageRouteHandler, MessageRouterPort } from "./ports.js";

export interface CommandRouteDefinition {
  readonly command: string;
  readonly handler: MessageRouteHandler;
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
  private readonly routes = new Map<string, MessageRouteHandler>();

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
    this.routes.set(command, definition.handler);
  }

  async dispatch(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const command = commandFromText(context.message.text);
    if (command === null) {
      return ok(null);
    }
    const handler = this.routes.get(command);
    if (handler === undefined) {
      return err(
        appError("ACTION_INVALID", "Unknown command", {
          command,
          correlationId: context.correlationId,
        }),
      );
    }
    return handler.handle(context);
  }
}
