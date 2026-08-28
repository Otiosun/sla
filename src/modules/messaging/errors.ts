import type { AppError, ErrorCode } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "./contracts.js";

const FRIENDLY_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: "Não consegui entender essa ação.",
  INVALID_ID: "Esse identificador não é válido.",
  IDEMPOTENCY_KEY_INVALID: "Essa ação não pode ser repetida com dados diferentes.",
  REVISION_CONFLICT: "Esse estado mudou antes da sua ação. Atualize e tente novamente.",
  INVALID_STATE_TRANSITION: "Essa ação não é válida no estado atual.",
  FEATURE_UNAVAILABLE: "Esse recurso está indisponível agora.",
  PLAYER_INELIGIBLE: "Você não pode usar essa ação neste momento.",
  FLOW_BLOCKED: "Essa ação está bloqueada pelo fluxo atual.",
  ACTION_INVALID: "Essa ação não pôde ser executada.",
  NOT_FOUND: "Não encontrei o alvo dessa ação.",
  FINGERPRINT_MISMATCH: "Recebi uma repetição incompatível dessa mensagem.",
  RATE_LIMITED: "Você está enviando ações rápido demais. Aguarde um pouco e tente novamente.",
};

export function presentMessagingError(
  context: MessageHandlerContext,
  error: AppError,
): MessageHandlerResult {
  return {
    resultRefType: "MESSAGING_ERROR",
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text: `${FRIENDLY_ERROR_MESSAGES[error.code]}\n\nCódigo de suporte: ${context.correlationId}`,
        },
        idempotencyKey: `messaging.error:${context.inboxMessageId}:${error.code}`,
      },
    ],
  };
}
