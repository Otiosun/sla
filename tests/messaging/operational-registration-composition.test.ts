import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

const pool = {} as Pool;

function message(text: string): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `composition-${text}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: "120363000000000001@g.us",
    occurredAt: "2026-09-02T15:00:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

describe("operational WhatsApp registration composition", () => {
  it("composes player registration and administrative review routes without legacy collisions", () => {
    const composition = createOperationalMessagingComposition(pool);

    expect(composition.router.classify(message("$registrar"))).toEqual({
      command: "registrar",
      sensitiveActionKey: "command:registrar",
    });
    expect(composition.router.classify(message("$confirmar"))).toEqual({
      command: "confirmar",
      sensitiveActionKey: null,
    });
    expect(composition.router.classify(message("$verficha"))).toEqual({
      command: "verficha",
      sensitiveActionKey: null,
    });
    expect(composition.router.classify(message("$aprovar"))).toEqual({
      command: "aprovar",
      sensitiveActionKey: "command:aprovar",
    });
    expect(composition.router.classify(message("$ajustes"))).toEqual({
      command: "ajustes",
      sensitiveActionKey: "command:ajustes",
    });
    expect(composition.router.classify(message("$rejeitar"))).toEqual({
      command: "rejeitar",
      sensitiveActionKey: "command:rejeitar",
    });
    expect(typeof composition.admitFreeform).toBe("function");
  });
});
