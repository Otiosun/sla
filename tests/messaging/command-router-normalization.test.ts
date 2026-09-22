import { describe, expect, it } from "vitest";
import {
  type IncomingMessage,
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { type CommandRouteDefinition, MessageRouter } from "../../src/modules/messaging/router.js";
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
  onHandle: (handlerContext: MessageHandlerContext) => void = () => {},
): CommandRouteDefinition & { readonly aliases: readonly string[] } {
  return {
    command,
    aliases,
    rateLimitClass,
    handler: {
      async handle(handlerContext) {
        onHandle(handlerContext);
        return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
      },
    },
  };
}

describe("command router normalization", () => {
  it("folds Portuguese diacritics and casing on the command token only", async () => {
    let observedText: string | null = null;
    const router = new MessageRouter([
      route("pokedex", [], "STANDARD", (handlerContext) => {
        observedText = handlerContext.message.text;
      }),
    ]);
    const message = incoming("/POKÉDEX João Ávila");

    const result = await router.dispatch(context(message));

    expect(result.ok).toBe(true);
    expect(observedText).toBe("/POKÉDEX João Ávila");
    expect(router.classify(message)).toEqual({ command: "pokedex", sensitiveActionKey: null });
  });

  it("accepts slash commands as the only mechanical prefix", async () => {
    const observed: string[] = [];
    const router = new MessageRouter([
      route("pokedex", [], "STANDARD", (handlerContext) => {
        observed.push(handlerContext.message.text ?? "");
      }),
    ]);
    const message = incoming("/POKÉDEX João Ávila");

    expect(router.admitsCommand(message)).toBe(true);
    expect(router.classify(message)).toEqual({ command: "pokedex", sensitiveActionKey: null });
    expect((await router.dispatch(context(message))).ok).toBe(true);
    expect(observed).toEqual(["/POKÉDEX João Ávila"]);
  });

  it("keeps dollar-prefixed text mechanically inert", async () => {
    let calls = 0;
    const router = new MessageRouter([
      route("pokedex", [], "STANDARD", () => {
        calls += 1;
      }),
    ]);
    const message = incoming("$POKÉDEX João Ávila");

    expect(router.admitsCommand(message)).toBe(false);
    expect(router.classify(message)).toEqual({ command: null, sensitiveActionKey: null });
    expect(await router.dispatch(context(message))).toEqual({ ok: true, value: null });
    expect(calls).toBe(0);
  });

  it("routes aliases while classifying them as the canonical command", async () => {
    let calls = 0;
    const router = new MessageRouter([
      route("pokedex", ["dex"], "STANDARD", () => {
        calls += 1;
      }),
    ]);
    const message = incoming("/DEX");

    expect(router.classify(message)).toEqual({ command: "pokedex", sensitiveActionKey: null });
    expect((await router.dispatch(context(message))).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("keeps sensitive rate-limit identity canonical across aliases", () => {
    const router = new MessageRouter([route("regiao", ["region"], "SENSITIVE")]);

    expect(router.classify(incoming("/REGION 2"))).toEqual({
      command: "regiao",
      sensitiveActionKey: "command:regiao",
    });
  });

  it("recognizes opted-in gameplay commands inside natural prose and preserves the original scene", async () => {
    let routedText: string | null = null;
    let originalText: string | null | undefined = null;
    const router = new MessageRouter([
      {
        ...route("centropokemon", [], "STANDARD", (handlerContext) => {
          routedText = handlerContext.message.text;
          originalText = handlerContext.originalMessageText;
        }),
        allowEmbedded: true,
      },
    ]);
    const text =
      "Depois de caminhar pela vila e conversar com algumas pessoas, entro no prédio e uso (/CENTROPOKÉMON), antes de continuar a cena.";
    const message = incoming(text);

    expect(router.admitsCommand(message)).toBe(true);
    expect((await router.dispatch(context(message))).ok).toBe(true);
    expect(routedText).toBe("/CENTROPOKÉMON");
    expect(originalText).toBe(text);
  });

  it("keeps embedded commands disabled unless the route explicitly opts in", () => {
    const router = new MessageRouter([route("centropokemon")]);
    const message = incoming("Eu caminho até lá e uso /centropokemon no meio da narrativa.");
    expect(router.admitsCommand(message)).toBe(false);
  });

  it("rejects aliases that collide after command normalization", () => {
    expect(() => new MessageRouter([route("pokedex", ["dex"]), route("dex")])).toThrow(
      "Messaging command route is already registered: dex",
    );
    expect(() => new MessageRouter([route("regiao"), route("região")])).toThrow(
      "Messaging command route is already registered: regiao",
    );
  });
});
