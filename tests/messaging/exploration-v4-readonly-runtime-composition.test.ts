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
  it("requires BOTH staging flags before preparation can be composed", () => {
    expect(() =>
      createOperationalMessagingComposition({} as Pool, null, null, null, null, null, null, true),
    ).toThrow("requires a separate explicit expedition calendar");

    const prepared = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
      true,
    );
    expect(prepared.admitCommand(input)).toBe(true);

    const defaultNoWrite = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
      false,
    );
    expect(defaultNoWrite.admitCommand(input)).toBe(true);
  });
  it("does not enable search without a third opt-in and encounter RNG", () => {
    const key = Buffer.alloc(32, 0x25);
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        null,
        null,
        null,
        null,
        null,
        "Etc/UTC",
        true,
        key,
      ),
    ).toThrow("requires explicit preparation");
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        "Etc/UTC",
        false,
        key,
      ),
    ).toThrow("requires explicit preparation");
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        null,
        true,
        key,
      ),
    ).toThrow("requires a separate explicit expedition calendar");
  });

  it("requires a real staging HMAC key even with all three explicit flags", () => {
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        "Etc/UTC",
        true,
        Buffer.alloc(12),
      ),
    ).toThrow("missing or too short");

    const candidate = createOperationalMessagingComposition(
      {} as Pool,
      { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
      null,
      null,
      null,
      null,
      "Etc/UTC",
      true,
      Buffer.alloc(32, 0x27),
    );
    expect(candidate.admitCommand({ ...input, text: "/explorar buscar" })).toBe(true);
    expect(
      createOperationalMessagingComposition({} as Pool).admitCommand({
        ...input,
        text: "/explorar buscar",
      }),
    ).toBe(false);
  });
});
