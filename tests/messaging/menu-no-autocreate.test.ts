import { describe, expect, it, vi } from "vitest";

import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { appError, err } from "../../src/shared-kernel/result.js";

describe("operational /menu identity guard", () => {
  it("shows Reception guidance for an unknown identity without creating a player foundation", async () => {
    const resolvePlayer = vi.fn(async () =>
      err(appError("NOT_FOUND", "Player identity was not found")),
    );
    const resolveOrCreatePlayer = vi.fn();

    const route = createOperationalUxRoutes({
      registration: { resolvePlayer, resolveOrCreatePlayer },
    } as never).find((candidate) => candidate.command === "menu");

    if (route === undefined) throw new Error("/menu route is missing");

    const result = await route.handler.handle({
      idempotencyKey: "menu-no-autocreate",
      message: {
        provider: "baileys",
        senderRef: "5511999999999@s.whatsapp.net",
        chatRef: "120000000000000000@g.us",
        text: "/menu",
        mentions: [],
        replyToExternalMessageId: null,
      },
    } as never);

    expect(result.ok).toBe(true);
    expect(resolvePlayer).toHaveBeenCalledOnce();
    expect(resolveOrCreatePlayer).not.toHaveBeenCalled();

    if (!result.ok) throw result.error;
    expect(result.value.resultRefId).toBeNull();
    expect(result.value.outgoing[0]).toMatchObject({
      messageType: "TEXT",
      payload: { text: expect.stringContaining("/registrar") },
    });
  });
});
