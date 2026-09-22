import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessagingRateLimitDecision,
} from "../../src/modules/messaging/contracts.js";
import type { MessageRouterPort, MessagingRepository } from "../../src/modules/messaging/ports.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const message: IncomingMessage = {
  provider: "baileys",
  externalMessageId: "completion-test",
  senderRef: "sender",
  chatRef: "chat",
  occurredAt: "2026-09-12T06:00:00.000Z",
  text: "/teste",
  mediaRefs: [],
  replyToExternalMessageId: null,
};

function repository(
  completeIncoming: MessagingRepository["completeIncoming"],
): MessagingRepository & { readonly failed: ReturnType<typeof vi.fn> } {
  const failed = vi.fn(async () => {});
  const allowed: MessagingRateLimitDecision = {
    allowed: true,
    replayed: false,
    limitedScope: null,
    retryAfterMs: 0,
  };
  return {
    failed,
    claimIncoming: async (incoming) =>
      ok({
        status: "CLAIMED",
        inboxMessageId: "inbox-completion-test",
        correlationId: "correlation-completion-test",
        message: incoming,
        resultRefType: null,
        resultRefId: null,
      }),
    consumeRateLimits: async () => ok(allowed),
    completeIncoming,
    failIncoming: failed,
    claimOutbox: async () => [],
    markOutboxSent: async () => {},
    markOutboxFailed: async () => {},
    claimMediaJobs: async () => [],
    markMediaJobProcessed: async () => {},
    markMediaJobFailed: async () => {},
  };
}

const router: MessageRouterPort = {
  classify: () => ({ command: "teste", sensitiveActionKey: null }),
  dispatch: async () => ok({ resultRefType: "UAT", resultRefId: "help", outgoing: [] }),
};

describe("MessagingService completion failures", () => {
  it("terminalizes the inbox when completeIncoming returns an error Result", async () => {
    const store = repository(async () =>
      err(appError("FINGERPRINT_MISMATCH", "Outbox idempotency collision")),
    );
    const result = await new MessagingService(store, router).receive(message);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "FINGERPRINT_MISMATCH", details: { stage: "COMPLETE_INCOMING" } },
    });
    expect(store.failed).toHaveBeenCalledWith(
      "inbox-completion-test",
      "COMPLETE_INCOMING_FINGERPRINT_MISMATCH",
    );
  });

  it("attaches the inbound WhatsApp message as reply context before persistence", async () => {
    const completeIncoming = vi.fn(async () => ok(undefined));
    const store = repository(completeIncoming);
    const replyRouter: MessageRouterPort = {
      classify: () => ({ command: "teste", sensitiveActionKey: null }),
      dispatch: async (context) =>
        ok({
          resultRefType: null,
          resultRefId: null,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: { text: "Resposta" },
              idempotencyKey: "reply-context-test",
            },
          ],
        }),
    };

    const result = await new MessagingService(store, replyRouter).receive(message);

    expect(result.ok).toBe(true);
    expect(completeIncoming).toHaveBeenCalledOnce();
    const persisted = completeIncoming.mock.calls[0]?.[1];
    expect(persisted?.outgoing[0]?.payload).toMatchObject({
      text: "Resposta",
      replyToExternalMessageId: "completion-test",
      replyToSenderRef: "sender",
      replyToText: "/teste",
    });
  });

  it("terminalizes the inbox when completeIncoming throws", async () => {
    const store = repository(async () => {
      throw new Error("database write failed");
    });
    const result = await new MessagingService(store, router).receive(message);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID", details: { stage: "COMPLETE_INCOMING" } },
    });
    expect(store.failed).toHaveBeenCalledWith(
      "inbox-completion-test",
      "COMPLETE_INCOMING_EXCEPTION",
    );
  });
});
