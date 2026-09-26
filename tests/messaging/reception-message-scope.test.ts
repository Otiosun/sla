import { describe, expect, it, vi } from "vitest";
import {
  ReceptionCommandScopeGate,
  ReceptionScopedConversationResolver,
} from "../../src/modules/community/reception-message-scope.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000901",
    correlationId: "00000000-0000-4000-8000-000000000902",
    causationId: "00000000-0000-4000-8000-000000000901",
    idempotencyKey: `scope:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `message:${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-25T21:15:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function community(role: "RECEPTION" | "GAME") {
  return {
    resolveChat: async () =>
      role === "RECEPTION"
        ? {
            known: true,
            groupId: "00000000-0000-4000-8000-000000000911",
            role: "RECEPTION" as const,
            capabilities: ["onboarding" as const, "admin.review" as const],
          }
        : {
            known: true,
            groupId: "00000000-0000-4000-8000-000000000912",
            role: "GAME" as const,
            capabilities: ["player.basic" as const, "world" as const, "pve" as const],
          },
  };
}

describe("strict Reception messaging scope", () => {
  it.each([
    "registrar",
    "modo",
    "iniciais",
    "ficha",
    "salvar",
    "continuar",
    "editar",
    "confirmar",
    "verficha",
    "aprovar",
    "ajustes",
    "rejeitar",
  ])("allows Reception workflow command %s", async (command) => {
    const gate = new ReceptionCommandScopeGate(community("RECEPTION"));
    expect(await gate.admits(context(`/${command}`), command)).toBe(true);
  });

  it.each(["menu", "hub", "ir", "batalha", "loja", "teste"])(
    "silently rejects non-Reception command %s",
    async (command) => {
      const gate = new ReceptionCommandScopeGate(community("RECEPTION"));
      expect(await gate.admits(context(`/${command}`), command)).toBe(false);
    },
  );

  it("does not restrict commands outside Reception", async () => {
    const gate = new ReceptionCommandScopeGate(community("GAME"));
    expect(await gate.admits(context("/menu"), "menu")).toBe(true);
    expect(await gate.admits(context("/hub"), "hub")).toBe(true);
    expect(await gate.admits(context("/ir"), "ir")).toBe(true);
  });

  it("makes a scoped-out command produce zero outgoing and never call its handler", async () => {
    const handler = vi.fn(async () =>
      ok({ resultRefType: null, resultRefId: null, outgoing: [] }),
    );
    const router = new MessageRouter(
      [{ command: "menu", handler: { handle: handler } }],
      undefined,
      undefined,
      new ReceptionCommandScopeGate(community("RECEPTION")),
    );

    expect(await router.dispatch(context("/menu"))).toEqual(ok(null));
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes freeform Reception traffic only through Reception registration/welcome", async () => {
    const reception = {
      resolve: vi.fn(async () =>
        ok({ resultRefType: "RECEPTION", resultRefId: null, outgoing: [] }),
      ),
    };
    const fallback = {
      resolve: vi.fn(async () =>
        ok({ resultRefType: "WORLD", resultRefId: null, outgoing: [] }),
      ),
    };
    const resolver = new ReceptionScopedConversationResolver(
      community("RECEPTION"),
      reception,
      fallback,
    );

    const result = await resolver.resolve(context("texto livre"));
    expect(result).toMatchObject({ ok: true, value: { resultRefType: "RECEPTION" } });
    expect(reception.resolve).toHaveBeenCalledOnce();
    expect(fallback.resolve).not.toHaveBeenCalled();
  });

  it("keeps the normal freeform resolver outside Reception", async () => {
    const reception = {
      resolve: vi.fn(async () =>
        ok({ resultRefType: "RECEPTION", resultRefId: null, outgoing: [] }),
      ),
    };
    const fallback = {
      resolve: vi.fn(async () =>
        ok({ resultRefType: "WORLD", resultRefId: null, outgoing: [] }),
      ),
    };
    const resolver = new ReceptionScopedConversationResolver(
      community("GAME"),
      reception,
      fallback,
    );

    const result = await resolver.resolve(context("texto livre"));
    expect(result).toMatchObject({ ok: true, value: { resultRefType: "WORLD" } });
    expect(fallback.resolve).toHaveBeenCalledOnce();
    expect(reception.resolve).not.toHaveBeenCalled();
  });
});
