import type { MessageHandlerContext } from "../messaging/contracts.js";
import type {
  MessageConversationResolver,
  MessageRouteScopeGate,
} from "../messaging/router.js";
import { isReception } from "./reception-service.js";

const RECEPTION_COMMANDS = new Set([
  "registrar",
  "modo",
  "iniciais",
  "ficha",
  "salvar",
  "continuar",
  "editar",
  "confirmar",
  "verficha",
  "aprovar",
  "ajustes",
  "rejeitar",
]);

interface ReceptionCommunityResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<{
    readonly known: boolean;
    readonly groupId: string | null;
    readonly role: "RECEPTION" | "GAME" | "PVP" | "COMMUNITY" | "STAFF" | null;
    readonly capabilities: readonly (
      | "onboarding"
      | "player.basic"
      | "admin.review"
      | "world"
      | "pve"
      | "pvp"
      | "admin"
      | "observability"
    )[];
  }>;
}

export class ReceptionCommandScopeGate implements MessageRouteScopeGate {
  public constructor(private readonly community: ReceptionCommunityResolver) {}

  public async admits(context: MessageHandlerContext, canonicalCommand: string): Promise<boolean> {
    const group = await this.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isReception(group)) return true;
    return RECEPTION_COMMANDS.has(canonicalCommand);
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

export function isReceptionCommandAllowed(command: string): boolean {
  return RECEPTION_COMMANDS.has(command);
}
