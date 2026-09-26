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
  ACTION_INVALID: "Essa ação não pode ser concluída agora.",
  NOT_FOUND: "Não encontrei o alvo dessa ação.",
  FINGERPRINT_MISMATCH: "Recebi uma repetição incompatível dessa mensagem.",
  RATE_LIMITED: "Você está enviando ações rápido demais. Aguarde um pouco e tente novamente.",
};

function explicitUserMessage(error: AppError): string | null {
  const candidate = error.details?.userMessage;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 1_200) return null;
  return trimmed;
}

function validationUserMessage(error: AppError): string | null {
  if (error.code !== "VALIDATION_FAILED") return null;
  const candidate = error.message.trim();
  if (candidate.length === 0 || candidate.length > 1_200) return null;
  if (
    /^(Unknown command|Incoming message is invalid|Handler produced|Messaging |Command route)/u.test(
      candidate,
    )
  ) {
    return null;
  }
  return candidate;
}

function knownActionInvalidUserMessage(error: AppError): string | null {
  if (error.code !== "ACTION_INVALID") return null;

  const reason = typeof error.details?.reason === "string" ? error.details.reason : null;
  const progressionCode =
    typeof error.details?.progressionCode === "string" ? error.details.progressionCode : null;

  if (error.message === "PVP action is invalid") {
    if (reason === "self-challenge") return "Você não pode desafiar a si mesmo.";
    if (reason === "challenge-actor-forbidden")
      return "Somente o jogador correto pode executar essa ação do desafio.";
    return "Essa ação de PVP não está disponível agora.";
  }

  if (progressionCode === "MOVE_CHOICE_CONFLICT")
    return "Essa decisão de movimento mudou antes da sua confirmação. Use `/golpes` e tente novamente.";

  const exact: Readonly<Record<string, string>> = {
    "Battle has no current state": "A batalha ainda não possui um estado jogável.",
    "Player is not a participant in this battle": "Você não participa desta batalha.",
    "Required capture Ball is not available":
      "Você não possui a Poké Ball necessária para essa captura.",
    "Inventory balance is insufficient":
      "Você não possui itens suficientes para concluir essa ação.",
    "Wallet balance is insufficient": "Você não possui saldo suficiente para concluir essa compra.",
    "Daily fishing attempt limit reached":
      "Você já usou todas as tentativas de pesca disponíveis hoje.",
    "Fishing is unavailable here": "Não é possível pescar nesta área.",
    "A Pokémon Center cannot heal a team during an active battle":
      "Você não pode curar a equipe enquanto estiver em uma batalha ativa.",
    "An active Pokémon Center visit is required":
      "Entre no Centro Pokémon com `/centropokemon` antes de usar esse recurso.",
    "A 50-word scene in the current area is required":
      "Essa ação precisa de uma cena com pelo menos 50 palavras na área atual.",
    "PC is only available inside an active Pokémon Center visit":
      "O PC só pode ser usado dentro de uma visita ativa ao Centro Pokémon.",
    "At least one Pokemon must remain in the team":
      "Pelo menos um Pokémon precisa permanecer na equipe.",
    "The selected Pokemon is not in the active team":
      "O Pokémon selecionado não está na sua equipe ativa.",
    "The Pokemon team already has six members": "Sua equipe já está com seis Pokémon.",
    "The selected Pokemon is not stored in a PC box":
      "O Pokémon selecionado não está armazenado em uma Box.",
    "The destination Pokemon PC slot is already occupied": "Esse slot da Box já está ocupado.",
    "Trainer profile already has different values":
      "Seu perfil de treinador já foi criado com outros dados.",
    "Region is not active in the pinned content release":
      "Essa região não está disponível na versão atual do jogo.",
    "A different origin region was already selected":
      "Você já escolheu uma região de origem diferente.",
    "No starter is configured for the selected region":
      "Não há Pokémon inicial configurado para essa região.",
    "Starter claim context is missing":
      "A escolha do inicial perdeu o contexto. Use `/starters` para reabrir as opções.",
    "Player already claimed a different starter": "Você já escolheu outro Pokémon inicial.",
    "Selected starter is not available in this onboarding release":
      "Esse Pokémon inicial não está disponível nesta versão do cadastro.",
    "Cannot complete onboarding without a durable starter grant":
      "Não foi possível concluir o cadastro porque o Pokémon inicial ainda não foi confirmado.",
    "Persisted Registration service is unavailable":
      "O serviço de cadastro está temporariamente indisponível.",
    "Current area is inactive in the active content release":
      "Sua área atual não está mais ativa. O jogo precisa realocar seu personagem antes de continuar.",
    "Travel is temporarily unavailable after arrival":
      "Você acabou de chegar nesta área. Aguarde o tempo de deslocamento antes de viajar novamente.",
  };

  const direct = exact[error.message];
  if (direct !== undefined) return direct;

  if (error.message.startsWith("Administrative registration operation cannot execute from "))
    return "Essa revisão administrativa não pode ser executada no estado atual da ficha.";

  if (error.message.endsWith(" balance would exceed the supported BIGINT range"))
    return "Essa operação ultrapassaria o limite seguro de saldo e foi bloqueada.";

  return null;
}

export function presentMessagingError(
  context: MessageHandlerContext,
  error: AppError,
): MessageHandlerResult {
  const explicit = explicitUserMessage(error);
  const known = knownActionInvalidUserMessage(error);
  const validation = validationUserMessage(error);
  const message = explicit ?? known ?? validation ?? FRIENDLY_ERROR_MESSAGES[error.code];
  const shouldShowSupportCode =
    explicit === null &&
    known === null &&
    validation === null &&
    (error.code === "ACTION_INVALID" || error.code === "FEATURE_UNAVAILABLE");
  return {
    resultRefType: "MESSAGING_ERROR",
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text: shouldShowSupportCode
            ? `${message}\n\nCódigo de suporte: ${context.correlationId}`
            : message,
        },
        idempotencyKey: `messaging.error:${context.inboxMessageId}:${error.code}`,
      },
    ],
  };
}
