import { describe, expect, it, vi } from "vitest";
import { expeditionClock } from "../../src/modules/exploration/expedition-clock.js";
import type { ExplorationRotomPreview } from "../../src/modules/exploration/expedition-rotom-preview.js";
import { createExplorationRotomWhatsAppRoutes } from "../../src/modules/exploration/expedition-rotom-whatsapp.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  type IncomingMessage,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();

function incoming(text: string, id = "rotom-message"): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "baileys",
    externalMessageId: id,
    senderRef: "trainer-private-jid",
    chatRef: "world-group-jid",
    occurredAt: "2026-10-24T20:00:00-03:00",
    text,
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

const activeView: ExplorationRotomPreview = {
  locationName: "Campos de Yun",
  contentReleaseId: "published-world",
  phase: "ACTIVE",
  originMatchesCurrent: false,
  clock: expeditionClock("DAY", 45),
  usedThisWeek: 3,
  remainingThisWeek: 0,
  canPrepareUnderPolicy: false,
  canContinueUnderPolicy: true,
  destinations: [],
  actionsEnabled: false,
};

function harness() {
  const players = {
    resolvePlayer: vi.fn().mockResolvedValue(ok({ playerId, state: "COMPLETE" })),
  };
  const preview = {
    inspect: vi.fn().mockResolvedValue(ok(activeView)),
  };
  const authorize = vi.fn().mockResolvedValue(ok(undefined));
  const router = new MessageRouter(createExplorationRotomWhatsAppRoutes({ players, preview }), {
    authorize,
  });
  return { players, preview, authorize, router };
}

describe("Rotom WhatsApp read-only exploration command", () => {
  it("renders an ACTIVE post-travel session privately with all actions blocked", async () => {
    const h = harness();
    const result = await h.router.dispatch(context(incoming("/explorar")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outbound = result.value?.outgoing[0];
    expect(outbound).toMatchObject({
      destinationRef: "trainer-private-jid",
      messageType: "TEXT",
      idempotencyKey: "inbox:baileys:rotom-message:exploration-preview",
    });
    const text = String(outbound?.payload.text);
    expect(text.normalize("NFKC")).toContain("ROTOM · EXPLORAÇÃO");
    expect(text).toContain("◇ *𝗘𝗦𝗧𝗔𝗗𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*");
    expect(text).toContain("⌛ *Tempo restante:* 11h15");
    expect(text).toContain("Campos de Yun");
    expect(text).toContain("Origem preservada");
    expect(text).toContain("0 restantes");
    expect(text).toContain("não foram liberadas");
    expect(text).not.toContain("1. Viajar");
    expect(h.players.resolvePlayer).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: "trainer-private-jid",
    });
    expect(h.preview.inspect).toHaveBeenCalledWith(playerId);
    expect(h.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      }),
    );
  });

  it("allows status and retomar as read-only synonyms with no session mutation", async () => {
    const h = harness();
    for (const [index, command] of ["/explorar status", "/explorar retomar"].entries()) {
      const response = await h.router.dispatch(context(incoming(command, `msg-${index}`)));
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.value?.outgoing[0]?.payload.text).toContain("Em andamento");
      }
    }
    expect(h.preview.inspect).toHaveBeenCalledTimes(2);
  });

  it("refuses a travel/capture argument without reading the expedition", async () => {
    const h = harness();
    const result = await h.router.dispatch(context(incoming("/explorar viajar Campos de Yun")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.outgoing[0]?.payload.text).toContain("Nenhuma ação será executada");
      expect(result.value?.outgoing[0]?.payload.text).toContain("◇ *𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔𝗥 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢*");
    }
    expect(h.players.resolvePlayer).not.toHaveBeenCalled();
    expect(h.preview.inspect).not.toHaveBeenCalled();
  });

  it("does not resolve identity or read expedition data when authorization fails", async () => {
    const h = harness();
    h.authorize.mockResolvedValue(err(appError("PLAYER_INELIGIBLE", "Denied")));
    const result = await h.router.dispatch(context(incoming("/explorar")));
    expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(h.players.resolvePlayer).not.toHaveBeenCalled();
    expect(h.preview.inspect).not.toHaveBeenCalled();
  });

  it("blocks uncompleted onboarding even if the policy gate permits the command", async () => {
    const h = harness();
    h.players.resolvePlayer.mockResolvedValue(ok({ playerId, state: "PROFILE_CREATED" }));
    const result = await h.router.dispatch(context(incoming("/explorar")));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.outgoing[0]?.payload.text).toContain("Conclua seu cadastro");
    }
    expect(h.preview.inspect).not.toHaveBeenCalled();
  });

  it("does not emit a false status on World/catalogue/cursor validation failures", async () => {
    const h = harness();
    h.preview.inspect.mockResolvedValue(err(appError("FLOW_BLOCKED", "World mismatch")));
    const result = await h.router.dispatch(context(incoming("/explorar")));
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(h.preview.inspect).toHaveBeenCalledOnce();
  });

  it("keeps the same outbox key on duplicate provider delivery", async () => {
    const h = harness();
    const message = context(incoming("/explorar", "same-provider-message"));
    const first = await h.router.dispatch(message);
    const retry = await h.router.dispatch(message);
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(first.value?.outgoing).toEqual(retry.value?.outgoing);
      expect(first.value?.outgoing[0]?.idempotencyKey).toBe(
        "inbox:baileys:same-provider-message:exploration-preview",
      );
    }
  });

  it("is not an unprotected standalone route", async () => {
    const h = harness();
    const router = new MessageRouter(
      createExplorationRotomWhatsAppRoutes({ players: h.players, preview: h.preview }),
    );
    expect(await router.dispatch(context(incoming("/explorar")))).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(h.preview.inspect).not.toHaveBeenCalled();
  });
  it.each([
    "/explorar iniciar",
    "/explorar buscar",
    "/explorar encontrar",
    "/explorar batalhar",
    "/explorar capturar",
    "/explorar resultados",
  ])("never represents %s as an executable WhatsApp action before the release gate", async (command) => {
    const h = harness();
    const result = await h.router.dispatch(
      context(incoming(command, `blocked-${command.split(" ").at(-1)}`)),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outgoing = result.value?.outgoing;
    expect(outgoing).toHaveLength(1);
    expect(outgoing?.[0]?.destinationRef).toBe("trainer-private-jid");
    expect(String(outgoing?.[0]?.payload.text)).toContain("Nenhuma ação será executada");
    expect(String(outgoing?.[0]?.payload.text)).toContain("Função indisponível");
    expect(h.players.resolvePlayer).not.toHaveBeenCalled();
    expect(h.preview.inspect).not.toHaveBeenCalled();
  });
});
