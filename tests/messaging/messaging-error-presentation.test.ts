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
    expect(result.outgoing[0]?.payload.text).toContain("Código de suporte:");
  });

  it("never uses the old generic ACTION_INVALID copy", () => {
    const result = presentMessagingError(
      context(),
      appError("ACTION_INVALID", "internal detail must not be exposed"),
    );

    expect(result.outgoing[0]?.payload.text).toContain(
      "O bot encontrou uma falha interna ao processar esta ação.",
    );
    expect(result.outgoing[0]?.payload.text).not.toContain("Essa ação não pôde ser executada.");
    expect(result.outgoing[0]?.payload.text).not.toContain("internal detail must not be exposed");
  });
});
