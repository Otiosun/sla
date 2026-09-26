import type { MessageHandlerContext } from "../messaging/contracts.js";
import type { CommunityChatContext } from "./contracts.js";
import type {
  MessageConversationResolver,
  MessageRouteScopeGate,
} from "../messaging/router.js";
import { isReception } from "./reception-service.js";

const RECEPTION_PLAYER_COMMANDS = new Set([
  "registrar",
  "modo",
  "iniciais",
  "ficha",
  "salvar",
  "continuar",
  "editar",
  "confirmar",
]);

const RECEPTION_ADMIN_COMMAND_CAPABILITIES = new Map([
  ["verficha", "player.registration.read"],
  ["aprovar", "player.registration.approve"],
  ["ajustes", "player.registration.request_changes"],
  ["rejeitar", "player.registration.reject"],
]);

interface ReceptionCommunityResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

export class ReceptionCommandScopeGate implements MessageRouteScopeGate {
  public constructor(private readonly community: ReceptionCommunityResolver) {}

  public async admits(context: MessageHandlerContext, canonicalCommand: string): Promise<boolean> {
    const group = await this.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isReception(group)) return true;
    return isReceptionCommandAllowed(canonicalCommand);
  }
}

export class ReceptionScopedConversationResolver implements MessageConversationResolver {
  public constructor(
    private readonly community: ReceptionCommunityResolver,
    private readonly reception: MessageConversationResolver,
    private readonly fallback: MessageConversationResolver,
  ) {}

  public async resolve(context: MessageHandlerContext) {
    const group = await this.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (isReception(group)) {
      return this.reception.resolve(context);
    }
    return this.fallback.resolve(context);
  }
}

export function isReceptionPlayerCommand(command: string): boolean {
  return RECEPTION_PLAYER_COMMANDS.has(command);
}

export function receptionAdminCapabilityFor(command: string): string | null {
  return RECEPTION_ADMIN_COMMAND_CAPABILITIES.get(command) ?? null;
}

export function isReceptionCommandAllowed(command: string): boolean {
  return isReceptionPlayerCommand(command) || receptionAdminCapabilityFor(command) !== null;
}
