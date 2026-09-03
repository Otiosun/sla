import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { MessageConversationResolver } from "../messaging/router.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type {
  ReceptionFirstInteractionInput,
  ReceptionWelcome,
} from "./reception-service.js";

interface RegistrationConversation {
  admits(message: IncomingMessage): Promise<boolean>;
  resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>>;
}

interface ReceptionFirstInteraction {
  admitsFirstInteraction(input: ReceptionFirstInteractionInput): Promise<boolean>;
  firstInteraction(input: ReceptionFirstInteractionInput): Promise<Result<ReceptionWelcome | null>>;
}

export interface ReceptionAwareConversationResolverDependencies {
  readonly registration: RegistrationConversation;
  readonly reception: ReceptionFirstInteraction;
}

function receptionInput(message: IncomingMessage): ReceptionFirstInteractionInput {
  return {
    provider: message.provider,
    chatRef: message.chatRef,
    externalId: message.senderRef,
  };
}

export class ReceptionAwareConversationResolver implements MessageConversationResolver {
  public constructor(
    private readonly dependencies: ReceptionAwareConversationResolverDependencies,
  ) {}

  public async admits(message: IncomingMessage): Promise<boolean> {
    if (await this.dependencies.registration.admits(message)) return true;
    return this.dependencies.reception.admitsFirstInteraction(receptionInput(message));
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const registration = await this.dependencies.registration.resolve(context);
    if (!registration.ok || registration.value !== null) return registration;

    const welcome = await this.dependencies.reception.firstInteraction(
      receptionInput(context.message),
    );
    if (!welcome.ok) return welcome;
    if (welcome.value === null) return ok(null);

    return ok({
      resultRefType: "RECEPTION_WELCOME",
      resultRefId: welcome.value.playerId,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: { text: welcome.value.text },
          idempotencyKey: `${context.idempotencyKey}:reception-welcome`,
        },
      ],
    });
  }
}
