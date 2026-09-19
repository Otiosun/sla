import { describe, expect, it } from "vitest";
import { SimulatedWhatsAppAdapter } from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";

const outgoing: PendingOutboxMessage = {
  id: "00000000-0000-4000-8000-000000000003",
  channel: "whatsapp",
  destinationRef: "120363000000000001@g.us",
  messageType: "TEXT",
  payload: { text: "Bem-vindo a Zhoulia." },
  idempotencyKey: "sim:reply:1",
  correlationId: "00000000-0000-4000-8000-000000000002",
  causationId: "00000000-0000-4000-8000-000000000001",
  attempts: 1,
};

describe("simulated whatsapp adapter", () => {
  it("injects Baileys-shaped traffic and records a deterministic transcript", async () => {
    const states: string[] = [];
    const received: unknown[] = [];
    const adapter = new SimulatedWhatsAppAdapter({
      now: () => new Date("2026-09-19T23:00:00.000Z"),
      providerMessageIdFor: (message) => `BAILEYS-${message.id}`,
      onConnectionState: (state) => {
        states.push(state);
      },
    });

    await adapter.start(async (message) => {
      received.push(message);
    });
    const incoming = await adapter.injectText({
      externalMessageId: "WA-IN-1",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      text: "$menu",
      mentions: ["5579888888888@s.whatsapp.net"],
      replyToExternalMessageId: "WA-OUT-0",
    });
    const receipt = await adapter.send(outgoing);
    await adapter.stop();

    expect(incoming).toEqual({
      provider: "baileys",
      externalMessageId: "WA-IN-1",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-19T23:00:00.000Z",
      text: "$menu",
      mentions: ["5579888888888@s.whatsapp.net"],
      mediaRefs: [],
      replyToExternalMessageId: "WA-OUT-0",
    });
    expect(received).toEqual([incoming]);
    expect(receipt).toEqual({
      providerExternalMessageId: "BAILEYS-00000000-0000-4000-8000-000000000003",
    });
    expect(states).toEqual(["CONNECTED", "DISCONNECTED"]);
    expect(adapter.transcript.map((entry) => entry.direction)).toEqual([
      "SYSTEM",
      "INBOUND",
      "OUTBOUND",
      "SYSTEM",
    ]);
  });

  it("simulates disconnects, delivery failures, replay ids and membership events", async () => {
    const memberships: unknown[] = [];
    const adapter = new SimulatedWhatsAppAdapter({
      onMembership: async (event) => {
        memberships.push(event);
      },
    });

    await adapter.start(async () => {});
    await adapter.injectMembership({
      chatRef: "120363000000000001@g.us",
      externalId: "5579999999999@s.whatsapp.net",
      action: "add",
    });

    await adapter.setConnected(false);
    await expect(
      adapter.injectText({
        senderRef: "5579999999999@s.whatsapp.net",
        chatRef: "120363000000000001@g.us",
        text: "$menu",
      }),
    ).rejects.toThrow("disconnected");

    await adapter.setConnected(true);
    const first = await adapter.injectText({
      externalMessageId: "REPLAY-ME",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      text: "$menu",
    });
    const replay = await adapter.injectText({
      externalMessageId: "REPLAY-ME",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      text: "$menu",
    });
    expect(replay.externalMessageId).toBe(first.externalMessageId);

    adapter.failNext();
    await expect(adapter.send(outgoing)).rejects.toThrow("delivery failure");
    await adapter.send(outgoing);

    expect(memberships).toEqual([
      {
        provider: "baileys",
        chatRef: "120363000000000001@g.us",
        externalId: "5579999999999@s.whatsapp.net",
        action: "add",
      },
    ]);
    expect(
      adapter.transcript.filter(
        (entry) => entry.direction === "SYSTEM" && entry.event === "DELIVERY_FAILURE",
      ),
    ).toHaveLength(1);
    await adapter.stop();
  });
});
