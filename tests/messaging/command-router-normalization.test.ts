import { describe, expect, it } from "vitest";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  type IncomingMessage,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import {
  type CommandRouteDefinition,
  MessageRouter,
} from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

function incoming(text: string): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "baileys",
    externalMessageId: `msg-${text}`,
    senderRef: "sender-1",
    chatRef: "chat-1",
    occurredAt: "2026-08-31T03:30:00-03:00",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

function context(message: IncomingMessage): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000001",
    correlationId: "00000000-0000-4000-8000-000000000002",
    causationId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: incomingMessageIdempotencyKey(message),
    message,
  };
}

function route(
  command: string,
  aliases: readonly string[] = [],
  rateLimitClass: "STANDARD" | "SENSITIVE" = "STANDARD",
): CommandRouteDefinition & { readonly aliases: readonly string[] } {
  return {
    command,
    aliases,
    rateLimitClass,
    handler: {
      async handle(handlerContext) {
        return ok({
          resultRefType: null,
          resultRefId: null,
          outgoing: [],
          observedText: handlerContext.message.text,
        } as never);
      },
    },
  };
}

describe("command router normalization", () => {
  it("folds Portuguese diacritics and casing on the command token only", async () => {
    let observedText: string | null = null;
    const router = new MessageRouter([
      {
        command: "pokedex",
        handler: {
          async handle(handlerContext) {
            observedText = handlerContext.message.text;
            return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
          },
        },
      },
    ]);
    const message = incoming("$POKÉDEX João Ávila");

    const result = await router.dispatch(context(message));

    expect(result.ok).toBe(true);
    expect(observedText).toBe("$POKÉDEX João Ávila");
    expect(router.classify(message)).toEqual({ command: "pokedex", sensitiveActionKey: null });
  });

  it("routes aliases while classifying them as the canonical command", async () => {
    let calls = 0;
    const definition = route("pokedex", ["dex"]);
    definition.handler.handle = async () => {
      calls += 1;
      return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
    };
    const router = new MessageRouter([definition]);
    const message = incoming("$DEX");

    expect(router.classify(message)).toEqual({ command: "pokedex", sensitiveActionKey: null });
    expect((await router.dispatch(context(message))).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("keeps sensitive rate-limit identity canonical across aliases", () => {
    const router = new MessageRouter([route("regiao", ["region"], "SENSITIVE")]);

    expect(router.classify(incoming("$REGION 2"))).toEqual({
      command: "regiao",
      sensitiveActionKey: "command:regiao",
    });
  });

  it("rejects aliases that collide after command normalization", () => {
    expect(
      () => new MessageRouter([route("pokedex", ["dex"]), route("dex")]),
    ).toThrow("Messaging command route is already registered: dex");
    expect(
      () => new MessageRouter([route("regiao"), route("região")]),
    ).toThrow("Messaging command route is already registered: regiao");
  });
});
