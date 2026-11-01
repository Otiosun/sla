import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

const input: IncomingMessage = {
  provider: "baileys",
  externalMessageId: "exploration-optin-1",
  senderRef: "5579999999999@s.whatsapp.net",
  chatRef: "120363123456789@g.us",
  occurredAt: "2026-11-01T12:00:00.000Z",
  text: "/explorar status",
  replyToExternalMessageId: null,
  mediaRefs: [],
};

describe("Exploration V4 status is NOT a default runtime route", () => {
  it("keeps exploration command unknown with the exact production positional defaults", () => {
    const composition = createOperationalMessagingComposition({} as Pool);
    expect(composition.admitCommand(input)).toBe(false);
  });

  it("registers only the read-only status command with an explicit staging calendar", () => {
    const composition = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
    );
    expect(composition.admitCommand(input)).toBe(true);
    expect(composition.router.classify(input).command).toBe("explorar");
  });

  it("rejects an invalid staging calendar before SQL or messaging", () => {
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        null,
        null,
        null,
        null,
        null,
        "Mars/Zhoulia",
      ),
    ).toThrow();
  });
});
