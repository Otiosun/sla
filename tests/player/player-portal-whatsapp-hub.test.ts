import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { createHubWhatsAppRoutes } from "../../src/modules/player-portal/whatsapp-handlers.js";
import { ok } from "../../src/shared-kernel/result.js";

const TICKET = "A".repeat(43);
const SENDER = "5511999999999@s.whatsapp.net";

function context(text = "/site", chatRef = SENDER): MessageHandlerContext {
  return {
    inboxMessageId: "inbox-hub-1",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "inbox-hub-1",
    idempotencyKey: "inbox:test:hub-1",
    message: {
      provider: "baileys",
      externalMessageId: "message-hub-1",
      senderRef: SENDER,
      chatRef,
      occurredAt: "2026-09-18T17:00:00-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function routerFor(routes: ReturnType<typeof createHubWhatsAppRoutes>): MessageRouter {
  return new MessageRouter(routes, {
    authorize: async () => ok(undefined),
  });
}

describe("WhatsApp /site command", () => {
  it("issues a one-shot ticket only in the URL fragment", async () => {
    const issue = vi.fn(async (_identity: ExternalIdentity) =>
      ok({ ticket: TICKET, expiresAt: new Date("2026-09-18T20:05:00.000Z") }),
    );
    const result = await routerFor(
      createHubWhatsAppRoutes({
        tickets: { issue },
        publicUrl: "https://hub.example.test/",
      }),
    ).dispatch(context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outgoing = result.value?.outgoing[0];
    const text = outgoing?.payload.text;
    expect(outgoing).toMatchObject({
      destinationRef: SENDER,
      messageType: "TEXT_WITH_TYPING",
      payload: { typingMs: 5_000 },
    });
    expect(text).toContain(`https://hub.example.test/#hub_ticket=${TICKET}`);
    expect(text).not.toContain("playerId");
    expect(text).not.toContain(SENDER);
    expect(issue).toHaveBeenCalledWith({ provider: "baileys", externalId: SENDER });
  });

  it("is sensitive, active-only and mechanically-ready", () => {
    const [route] = createHubWhatsAppRoutes({
      tickets: { issue: async () => ok({ ticket: TICKET, expiresAt: new Date() }) },
      publicUrl: "https://hub.example.test/",
    });

    expect(route).toMatchObject({
      command: "site",
      rateLimitClass: "SENSITIVE",
      policy: {
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    });
  });

  it("never issues or leaks a ticket when /site is requested in a group", async () => {
    const issue = vi.fn(async () => ok({ ticket: TICKET, expiresAt: new Date() }));
    const result = await routerFor(
      createHubWhatsAppRoutes({
        tickets: { issue },
        publicUrl: "https://hub.example.test/",
      }),
    ).dispatch(context("/site", "120363000000000001@g.us"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(issue).not.toHaveBeenCalled();
    expect(result.value?.outgoing).toHaveLength(1);
    expect(result.value?.outgoing[0]).toMatchObject({
      destinationRef: "120363000000000001@g.us",
      messageType: "TEXT",
    });
    expect(result.value?.outgoing[0]?.payload.text).toContain("PV");
    expect(result.value?.outgoing[0]?.payload.text).toContain("/site");
    expect(result.value?.outgoing[0]?.payload.text).not.toContain("hub_ticket");
  });

  it("fails closed without a public Hub URL", async () => {
    const issue = vi.fn(async () => ok({ ticket: TICKET, expiresAt: new Date() }));
    const result = await routerFor(
      createHubWhatsAppRoutes({ tickets: { issue }, publicUrl: null }),
    ).dispatch(context());

    expect(result.ok).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });
});
