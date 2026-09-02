import { describe, expect, it } from "vitest";
import { FakeWhatsAppAdapter } from "../../src/adapters/whatsapp/fake-whatsapp-adapter.js";
import { WhatsAppMessagingRuntime } from "../../src/adapters/whatsapp/runtime.js";
import {
  IncomingMessageSchema,
  incomingMessageFingerprint,
  incomingMessageIdempotencyKey,
  type IncomingMessage,
  type PendingOutboxMessage,
} from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import type { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { ok } from "../../src/shared-kernel/result.js";

const message: IncomingMessage = IncomingMessageSchema.parse({
  provider: "baileys",
  externalMessageId: "msg-1",
  senderRef: "sender-1",
  chatRef: "chat-1",
  occurredAt: "2026-08-27T22:00:00-03:00",
  text: "$ping hello",
  mediaRefs: [],
  replyToExternalMessageId: null,
});

describe("messaging boundary", () => {
  it("normalizes a strict provider-neutral incoming message", () => {
    expect(message.provider).toBe("baileys");
    expect(message.mediaRefs).toEqual([]);
    expect(incomingMessageFingerprint(message)).toHaveLength(64);
    expect(incomingMessageIdempotencyKey(message)).toBe("inbox:baileys:msg-1");
    expect(
      IncomingMessageSchema.safeParse({ ...message, rawProviderPayload: { secret: true } }).success,
    ).toBe(false);
  });

  it("routes only explicit commands and leaves freeform campaign text untouched", async () => {
    let calls = 0;
    const router = new MessageRouter([
      {
        command: "$ping",
        handler: {
          async handle(context) {
            calls += 1;
            expect(context.idempotencyKey).toBe("inbox:baileys:msg-1");
            return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
          },
        },
      },
    ]);
    const context = {
      inboxMessageId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000002",
      causationId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: incomingMessageIdempotencyKey(message),
      message,
    };

    const routed = await router.dispatch(context);
    expect(routed.ok).toBe(true);
    expect(calls).toBe(1);

    const freeform = await router.dispatch({
      ...context,
      message: { ...message, text: "Charmander observa o mato em silêncio." },
    });
    expect(freeform).toEqual(ok(null));
    expect(calls).toBe(1);
  });

  it("drops freeform WhatsApp traffic before the inbox while preserving command candidates", async () => {
    const adapter = new FakeWhatsAppAdapter();
    const received: IncomingMessage[] = [];
    const messaging = {
      async receive(incoming: IncomingMessage) {
        received.push(incoming);
        return ok({
          status: "PROCESSED" as const,
          inboxMessageId: "00000000-0000-4000-8000-000000000010",
          correlationId: "00000000-0000-4000-8000-000000000011",
          resultRefType: null,
          resultRefId: null,
        });
      },
    } as unknown as MessagingService;
    const outboxWorker = {
      async runOnce() {
        return { claimed: 0, sent: 0, failed: 0 };
      },
    } as unknown as OutboxWorker;
    const runtime = new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker);

    await runtime.start();
    await adapter.inject({
      ...message,
      externalMessageId: "msg-freeform",
      text: "Charmander observa o mato em silêncio.",
    });
    await adapter.inject({
      ...message,
      externalMessageId: "msg-command",
      text: "   $menu",
    });
    await runtime.stop();

    expect(received.map((incoming) => incoming.externalMessageId)).toEqual(["msg-command"]);
  });

  it("admits only explicitly eligible freeform traffic for conversational flows", async () => {
    const adapter = new FakeWhatsAppAdapter();
    const received: IncomingMessage[] = [];
    const messaging = {
      async receive(incoming: IncomingMessage) {
        received.push(incoming);
        return ok({
          status: "PROCESSED" as const,
          inboxMessageId: "00000000-0000-4000-8000-000000000012",
          correlationId: "00000000-0000-4000-8000-000000000013",
          resultRefType: null,
          resultRefId: null,
        });
      },
    } as unknown as MessagingService;
    const outboxWorker = {
      async runOnce() {
        return { claimed: 0, sent: 0, failed: 0 };
      },
    } as unknown as OutboxWorker;
    const runtime = new WhatsAppMessagingRuntime(adapter, messaging, outboxWorker, {
      admitFreeform: async (incoming) => incoming.chatRef === "reception@g.us",
    });

    await runtime.start();
    await adapter.inject({
      ...message,
      externalMessageId: "msg-scene",
      chatRef: "world@g.us",
      text: "Charmander observa o mato em silêncio.",
    });
    await adapter.inject({
      ...message,
      externalMessageId: "msg-registration-answer",
      chatRef: "reception@g.us",
      text: "Liora Vale",
    });
    await adapter.inject({
      ...message,
      externalMessageId: "msg-command-2",
      chatRef: "world@g.us",
      text: "$menu",
    });
    await runtime.stop();

    expect(received.map((incoming) => incoming.externalMessageId)).toEqual([
      "msg-registration-answer",
      "msg-command-2",
    ]);
  });
});

describe("fake whatsapp adapter", () => {
  it("injects normalized incoming messages and simulates delivery failures", async () => {
    const adapter = new FakeWhatsAppAdapter();
    const received: IncomingMessage[] = [];
    await adapter.start(async (incoming) => {
      received.push(incoming);
    });
    await adapter.inject(message);
    expect(received).toEqual([message]);

    const outgoing: PendingOutboxMessage = {
      id: "00000000-0000-4000-8000-000000000003",
      channel: "whatsapp",
      destinationRef: "chat-1",
      messageType: "TEXT",
      payload: { text: "pong" },
      idempotencyKey: "reply:msg-1",
      correlationId: "00000000-0000-4000-8000-000000000002",
      causationId: "00000000-0000-4000-8000-000000000001",
      attempts: 1,
    };
    adapter.failNext();
    await expect(adapter.send(outgoing)).rejects.toThrow("Simulated WhatsApp delivery failure");
    expect(adapter.sent).toHaveLength(0);
    await adapter.send(outgoing);
    expect(adapter.sent).toEqual([outgoing]);
    await adapter.stop();
  });
});
