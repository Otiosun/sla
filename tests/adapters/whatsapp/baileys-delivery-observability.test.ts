import { describe, expect, it } from "vitest";
import {
  messageReceiptDiagnostics,
  messageUpdateDiagnostics,
} from "../../../src/adapters/whatsapp/baileys-delivery-observability.js";

describe("Baileys delivery observability", () => {
  it("projects a group delivery receipt without participant identity or message content", () => {
    const diagnostics = messageReceiptDiagnostics([
      {
        key: {
          remoteJid: "120363431092011890@g.us",
          id: "22D12147D51B437F966939EFA67C5689",
          fromMe: true,
        },
        receipt: {
          userJid: "557999999999@s.whatsapp.net",
          receiptTimestamp: 1_760_000_000,
        },
      },
    ]);

    expect(diagnostics).toEqual([
      {
        source: "message-receipt.update",
        destinationRef: "120363431092011890@g.us",
        messageId: "22D12147D51B437F966939EFA67C5689",
        ack: "DELIVERED",
        providerTimestamp: 1_760_000_000,
        status: null,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("557999999999");
  });

  it("distinguishes read receipts from delivered receipts", () => {
    expect(
      messageReceiptDiagnostics([
        {
          key: {
            remoteJid: "120363431092011890@g.us",
            id: "623CE1BF03EA4172A1B094A94909207C",
          },
          receipt: { readTimestamp: "1760000001" },
        },
      ])[0]?.ack,
    ).toBe("READ");
  });

  it("ignores private chats and non-bot message ids", () => {
    expect(
      messageReceiptDiagnostics([
        {
          key: {
            remoteJid: "557999999999@s.whatsapp.net",
            id: "22D12147D51B437F966939EFA67C5689",
          },
          receipt: { receiptTimestamp: 1 },
        },
        {
          key: {
            remoteJid: "120363431092011890@g.us",
            id: "3EB0NOTOURDETERMINISTICID",
          },
          receipt: { receiptTimestamp: 2 },
        },
      ]),
    ).toEqual([]);
  });

  it("projects group message status updates with only safe metadata", () => {
    expect(
      messageUpdateDiagnostics([
        {
          key: {
            remoteJid: "120363431092011890@g.us",
            id: "22D12147D51B437F966939EFA67C5689",
          },
          update: { status: 3, messageTimestamp: 1_760_000_002 },
        },
      ]),
    ).toEqual([
      {
        source: "messages.update",
        destinationRef: "120363431092011890@g.us",
        messageId: "22D12147D51B437F966939EFA67C5689",
        ack: "STATUS_UPDATE",
        providerTimestamp: 1_760_000_002,
        status: 3,
      },
    ]);
  });
});
