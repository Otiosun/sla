import { describe, expect, it, vi } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { createHubWhatsAppRoutes } from "../../src/modules/player-portal/whatsapp-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

const TICKET = "A".repeat(43);
const SENDER = "5511999999999@s.whatsapp.net";

function context(text = "$hub"): MessageHandlerContext {
  return {
    inboxMessageId: "inbox-hub-1",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "inbox-hub-1",
    idempotencyKey: "inbox:test:hub-1",
    message: {
      provider: "baileys",
      externalMessageId: "message-hub-1",
      senderRef: SENDER,
      chatRef: SENDER,
      occurredAt: "2026-09-10T17:00:00-03:00",
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

function textOf(result: Awaited<ReturnType<MessageRouter["dispatch"]>>): string {
  if (!result.ok) throw new Error(`Expected successful route, got ${result.error.code}`);
  const payload = result.value?.outgoing[0]?.payload;
  return typeof payload?.text === "string" ? payload.text : "";
}

describe("WhatsApp $hub command", () => {
  it("issues a one-shot ticket for the canonical sender identity and returns it only in the URL fragment", async () => {
    const issue = vi.fn(async (_identity: ExternalIdentity) =>
      ok({ ticket: TICKET, expiresAt: new Date("2026-09-10T20:05:00.000Z") }),
    );
    const routes = createHubWhatsAppRoutes({
      tickets: { issue },
      publicUrl: "https://hub.example.test/",
    });

    const result = await routerFor(routes).dispatch(context());
    const text = textOf(result);

    expect(issue).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: SENDER,
    });
    expect(text).toContain(`https://hub.example.test/#hub_ticket=${TICKET}`);
    expect(text).not.toContain("playerId");
    expect(text).not.toContain(SENDER);
  });

  it("marks Hub login as sensitive and limits it to active, mechanically-ready players", () => {
    const [route] = createHubWhatsAppRoutes({
      tickets: { issue: async () => ok({ ticket: TICKET, expiresAt: new Date() }) },
      publicUrl: "https://hub.example.test/",
    });

    expect(route).toMatchObject({
      command: "hub",
      rateLimitClass: "SENSITIVE",
      policy: {
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    });
  });

  it("does not mint a ticket when no public Hub URL is configured", async () => {
    const issue = vi.fn(async () => ok({ ticket: TICKET, expiresAt: new Date() }));
    const routes = createHubWhatsAppRoutes({ tickets: { issue }, publicUrl: null });

    const result = await routerFor(routes).dispatch(context());
    const text = textOf(result);

    expect(issue).not.toHaveBeenCalled();
    expect(text).toContain("Hub");
    expect(text.toLowerCase()).toContain("indisponível");
  });
});
