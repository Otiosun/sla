import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { presentMessagingError } from "../../src/modules/messaging/errors.js";
import { appError } from "../../src/shared-kernel/result.js";

function context(): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000801",
    correlationId: "00000000-0000-4000-8000-000000000802",
    causationId: "00000000-0000-4000-8000-000000000801",
    idempotencyKey: "messaging-error-presentation",
    message: {
      provider: "baileys",
      externalMessageId: "error-presentation-message",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "5511999999999@s.whatsapp.net",
      occurredAt: "2026-09-21T18:00:00.000Z",
      text: "/teste",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

describe("messaging error presentation", () => {
  it("prefers an explicit safe user message", () => {
    const result = presentMessagingError(
      context(),
      appError("FLOW_BLOCKED", "internal policy detail", {
        userMessage: "Este comando não está habilitado neste grupo.",
      }),
    );

    expect(result.outgoing[0]?.payload.text).toContain(
      "Este comando não está habilitado neste grupo.",
    );
    expect(result.outgoing[0]?.payload.text).not.toContain("Código de suporte:");
  });

  it("never uses the old generic ACTION_INVALID copy", () => {
    const result = presentMessagingError(
      context(),
      appError("ACTION_INVALID", "internal detail must not be exposed"),
    );

    expect(result.outgoing[0]?.payload.text).toContain(
      "Essa ação não pode ser concluída agora.",
    );
    expect(result.outgoing[0]?.payload.text).toContain("Código de suporte:");
    expect(result.outgoing[0]?.payload.text).not.toContain("internal detail must not be exposed");
  });
  it.each([
    ["PVP action is invalid", { reason: "self-challenge" }, "Você não pode desafiar a si mesmo."],
    [
      "Daily fishing attempt limit reached",
      { dailyLimit: 5, remainingAttempts: 0 },
      "Você já usou todas as tentativas de pesca disponíveis hoje.",
    ],
    [
      "A Pokémon Center cannot heal a team during an active battle",
      {},
      "Você não pode curar a equipe enquanto estiver em uma batalha ativa.",
    ],
    [
      "At least one Pokemon must remain in the team",
      {},
      "Pelo menos um Pokémon precisa permanecer na equipe.",
    ],
    [
      "No starter is configured for the selected region",
      {},
      "Não há Pokémon inicial configurado para essa região.",
    ],
    ["Battle has no current state", {}, "A batalha ainda não possui um estado jogável."],
    [
      "Required capture Ball is not available",
      {},
      "Você não possui a Poké Ball necessária para essa captura.",
    ],
    [
      "Wallet balance is insufficient",
      {},
      "Você não possui saldo suficiente para concluir essa compra.",
    ],
  ])("translates known user-facing ACTION_INVALID states: %s", (message, details, expected) => {
    const result = presentMessagingError(context(), appError("ACTION_INVALID", message, details));

    expect(result.outgoing[0]?.payload.text).toContain(expected);
    expect(result.outgoing[0]?.payload.text).not.toContain(
      "Essa ação não pode ser concluída agora.",
    );
  });
});
