import { describe, expect, it, vi } from "vitest";
import { createSpawnWhatsAppRoute } from "../../src/modules/encounter/spawn-whatsapp.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = "11111111-1111-4111-8111-111111111111" as never;
const encounterId = "22222222-2222-4222-8222-222222222222" as never;

function context(mentions: readonly string[]): MessageHandlerContext {
  return {
    inboxMessageId: "inbox",
    correlationId: "33333333-3333-4333-8333-333333333333",
    causationId: "cause",
    idempotencyKey: "inbox:baileys:spawn-1",
    message: {
      provider: "baileys",
      externalMessageId: "spawn-1",
      senderRef: "narrator@s.whatsapp.net",
      chatRef: "group@g.us",
      occurredAt: "2026-09-10T00:00:00.000Z",
      text: "/spawn @target",
      mentions: [...mentions],
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

describe("PVE /spawn WhatsApp route", () => {
  it("requires exactly one provider mention before resolving a player or consuming RNG", async () => {
    const resolvePlayer = vi.fn();
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
    } as never);

    const output = await route.handler.handle(context([]));

    expect(output).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(resolvePlayer).not.toHaveBeenCalled();
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it("uses the actual marked WhatsApp identity and makes the marked player capture owner", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        snapshot: { level: 7 },
      }),
    );
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
    } as never);

    const output = await route.handler.handle(context(["target@s.whatsapp.net"]));

    expect(resolvePlayer).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: "target@s.whatsapp.net",
    });
    expect(createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        participantPlayerIds: [],
        idempotencyKey: "inbox:baileys:spawn-1",
      }),
    );
    expect(output).toMatchObject({ ok: true, value: { resultRefId: encounterId } });
  });
});
