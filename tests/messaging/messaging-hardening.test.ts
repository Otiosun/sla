import { describe, expect, it } from "vitest";
import { IncomingMessageSchema } from "../../src/modules/messaging/contracts.js";
import { presentMessagingError } from "../../src/modules/messaging/errors.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { appError, ok } from "../../src/shared-kernel/result.js";

const baseMessage = IncomingMessageSchema.parse({
  provider: "baileys",
  externalMessageId: "hardening-1",
  senderRef: "sender-hardening",
  chatRef: "chat-hardening",
  occurredAt: "2026-08-28T00:00:00-03:00",
  text: "$danger",
  mediaRefs: [],
  replyToExternalMessageId: null,
});

const noopHandler = {
  async handle() {
    return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
  },
};

describe("messaging operational hardening", () => {
  it("classifies only explicitly marked command routes as sensitive actions", () => {
    const router = new MessageRouter([
      { command: "danger", handler: noopHandler, rateLimitClass: "SENSITIVE" },
      { command: "profile", handler: noopHandler },
    ]);

    expect(router.classify(baseMessage)).toEqual({
      command: "danger",
      sensitiveActionKey: "command:danger",
    });
    expect(router.classify({ ...baseMessage, text: "$profile" })).toEqual({
      command: "profile",
      sensitiveActionKey: null,
    });
    expect(router.classify({ ...baseMessage, text: "uma cena narrativa livre" })).toEqual({
      command: null,
      sensitiveActionKey: null,
    });
  });

  it("presents typed errors without leaking internal message/details and keeps correlation id", () => {
    const context = {
      inboxMessageId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000002",
      causationId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "inbox:baileys:hardening-1",
      message: baseMessage,
    } as const;
    const presented = presentMessagingError(
      context,
      appError("FLOW_BLOCKED", "internal SQL-ish detail must never reach the user", {
        secretState: "hidden",
      }),
    );
    const payload = presented.outgoing[0]?.payload;
    const text = typeof payload?.text === "string" ? payload.text : "";

    expect(text).toContain("Código de suporte: 00000000-0000-4000-8000-000000000002");
    expect(text).toContain("bloqueada pelo fluxo atual");
    expect(text).not.toContain("internal SQL-ish detail");
    expect(text).not.toContain("hidden");
    expect(presented.outgoing[0]?.idempotencyKey).toBe(
      "messaging.error:00000000-0000-4000-8000-000000000001:FLOW_BLOCKED",
    );
  });
});
