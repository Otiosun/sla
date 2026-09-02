import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";

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
  it("composes the canonical registration router without colliding with the legacy registrar route", () => {
    const composition = createOperationalMessagingComposition(pool);

    expect(composition.router.classify(message("$registrar"))).toEqual({
      command: "registrar",
      sensitiveActionKey: "command:registrar",
    });
    expect(composition.router.classify(message("$confirmar"))).toEqual({
      command: "confirmar",
      sensitiveActionKey: null,
    });
    expect(typeof composition.admitFreeform).toBe("function");
  });
});
