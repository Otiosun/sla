import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { createHubWhatsAppRoutes } from "../../src/modules/player-portal/whatsapp-handlers.js";
import { ok } from "../../src/shared-kernel/result.js";

const TICKET = "A".repeat(43);
const SENDER = "5511999999999@s.whatsapp.net";

function context(text = "/hub", chatRef = SENDER): MessageHandlerContext {
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

describe("WhatsApp /hub command", () => {
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
    const text = result.value?.outgoing[0]?.payload.text;
    const accessUrl = String(text)
      .split("\n")
      .find((line) => line.startsWith("https://"));
    expect(accessUrl).toBeDefined();
    const parsedUrl = new URL(accessUrl ?? "https://invalid.test/");
    expect(parsedUrl.searchParams.get("hub_open")).toBe(
      String(new Date("2026-09-18T20:05:00.000Z").getTime()),
    );
    expect(parsedUrl.searchParams.has("hub_ticket")).toBe(false);
    expect(parsedUrl.hash).toBe(`#hub_ticket=${TICKET}`);
    expect(text).not.toContain("playerId");
    expect(text).not.toContain(SENDER);
    expect(issue).toHaveBeenCalledWith({ provider: "baileys", externalId: SENDER });
  });

  it("never exposes the personal Hub ticket in a group", async () => {
    const issue = vi.fn(async (_identity: ExternalIdentity) =>
      ok({ ticket: TICKET, expiresAt: new Date("2026-09-18T20:05:00.000Z") }),
    );
    const groupRef = "120363999999999999@g.us";
    const result = await routerFor(
      createHubWhatsAppRoutes({
        tickets: { issue },
        publicUrl: "https://hub.example.test/",
      }),
    ).dispatch(context("/hub", groupRef));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.outgoing).toHaveLength(2);
    const [privateReply, groupAcknowledgement] = result.value?.outgoing ?? [];
    expect(privateReply?.destinationRef).toBe(SENDER);
    expect(groupAcknowledgement?.destinationRef).toBe(groupRef);
    expect(privateReply?.idempotencyKey).toBe("inbox:test:hub-1:reply");
    expect(groupAcknowledgement?.idempotencyKey).toBe("inbox:test:hub-1:group-ack");
    const text = String(privateReply?.payload.text ?? "");
    const groupText = String(groupAcknowledgement?.payload.text ?? "");
    expect(text).toContain("https://hub.example.test/?hub_open=");
    expect(text).toContain(`#hub_ticket=${TICKET}`);
    expect(text).not.toContain(`hub_ticket=${TICKET}&`);
    expect(groupText).toContain("Enviei o acesso pessoal no seu privado");
    expect(groupText).not.toContain("hub.example.test");
    expect(groupText).not.toContain(TICKET);
    expect(groupText).not.toContain(SENDER);
  });

  it("never acknowledges or exposes a ticket in a group if issuing fails", async () => {
    const issue = vi.fn(async () => ({
      ok: false as const,
      error: { code: "FEATURE_UNAVAILABLE" as const, message: "Unable to issue ticket", details: {} },
    }));
    const result = await routerFor(
      createHubWhatsAppRoutes({
        tickets: { issue },
        publicUrl: "https://hub.example.test/",
      }),
    ).dispatch(context("/hub", "120363999999999999@g.us"));
    expect(result).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("is sensitive, active-only and mechanically-ready", () => {
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

  it("fails closed without a public Hub URL", async () => {
    const issue = vi.fn(async () => ok({ ticket: TICKET, expiresAt: new Date() }));
    const result = await routerFor(
      createHubWhatsAppRoutes({ tickets: { issue }, publicUrl: null }),
    ).dispatch(context());

    expect(result.ok).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });
});
