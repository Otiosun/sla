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

function operationalPoolForUnknownReceptionIdentity(): Pool {
  const query = async (sql: unknown) => {
    const statement = String(sql);
    if (statement.startsWith("BEGIN") || statement === "COMMIT" || statement === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (statement.includes("FROM community_groups") && statement.includes("provider = $1")) {
      return {
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider: "baileys",
            chat_ref: "120363000000000001@g.us",
            role: "RECEPTION",
            display_name: "Recepção",
            status: "ACTIVE",
            revision: "0",
          },
        ],
        rowCount: 1,
      };
    }
    if (statement.includes("FROM community_group_capabilities")) {
      return { rows: [{ capability_key: "onboarding" }], rowCount: 1 };
    }
    if (statement.includes("FROM player_identities")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected operational composition query: ${statement}`);
  };

  return {
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
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

  it("admits the first ordinary message from an unknown identity in active Reception", async () => {
    const composition = createOperationalMessagingComposition(
      operationalPoolForUnknownReceptionIdentity(),
    );

    expect(await composition.admitFreeform(message("oi"))).toBe(true);
  });
});
