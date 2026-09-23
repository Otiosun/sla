import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "inbox",
    correlationId: "correlation",
    causationId: "cause",
    idempotencyKey: "message",
    message: {
      provider: "baileys",
      externalMessageId: "external",
      senderRef: "sender",
      chatRef: "chat",
      occurredAt: "2026-09-18T00:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

describe("embedded mechanical command routing", () => {
  it("routes only opted-in commands embedded in prose and passes only the command line to the handler", async () => {
    const handle = vi.fn(async (_received: MessageHandlerContext) =>
      ok({ resultRefType: null, resultRefId: null, outgoing: [] }),
    );
    const router = new MessageRouter([
      { command: "movimento", allowEmbedded: true, handler: { handle } },
      { command: "perfil", handler: { handle: vi.fn() } },
    ]);

    const scene = context(
      "Pikachu espera a abertura e avança. /movimento Quick Attack\nA cena continua depois.",
    );
    expect(router.admitsCommand(scene.message)).toBe(true);
    const result = await router.dispatch(scene);
    expect(result.ok).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0].message.text).toBe("/movimento Quick Attack");
  });

  it("does not treat ordinary commands as embedded scene mechanics", () => {
    const router = new MessageRouter([
      {
        command: "perfil",
        handler: {
          handle: vi.fn(async () => ok({ resultRefType: null, resultRefId: null, outgoing: [] })),
        },
      },
    ]);
    expect(router.admitsCommand(context("Eu sigo andando. /perfil").message)).toBe(false);
  });

  it("rejects more than one embedded mechanical command in the same message", async () => {
    const handler = {
      handle: vi.fn(async () => ok({ resultRefType: null, resultRefId: null, outgoing: [] })),
    };
    const router = new MessageRouter([
      { command: "movimento", allowEmbedded: true, handler },
      { command: "fugir", allowEmbedded: true, handler },
    ]);
    const result = await router.dispatch(context("Cena. /movimento 1\nDepois /fugir"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });
});
