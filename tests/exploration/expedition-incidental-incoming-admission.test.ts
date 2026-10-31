import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import {
  incomingMessageIdempotencyKey,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { ExpeditionIncidentalIncomingAdmission } from "../../src/modules/exploration/expedition-incidental-incoming-admission.js";
import {
  createCorrelationId,
  createPlayerId,
  type EncounterId,
} from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";
import type { CaptureAttemptResult } from "../../src/modules/capture/contracts.js";
import type { ResolvePlayerResult } from "../../src/modules/player/contracts.js";
import type { BaileysMessageLike } from "../../src/adapters/whatsapp/baileys-provider-contracts.js";

const playerId = createPlayerId();
const correlationId = createCorrelationId();
const quotedId = "server-issued-message-id";
function message(body = "2", quote: string | null = quotedId): MessageHandlerContext {
  const raw: BaileysMessageLike = {
    key: {
      id: "incoming-capture-unique-id",
      remoteJid: "120363123456789@g.us",
      participant: "5579999999999@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1793390000,
    message: {
      extendedTextMessage: {
        text: body,
        ...(quote === null ? {} : { contextInfo: { stanzaId: quote } }),
      },
    },
  };
  const normalized = normalizeBaileysMessage(raw);
  if (normalized === null) throw Error("Baileys normalizer rejected test message");
  return {
    inboxMessageId: randomUUID(),
    correlationId,
    causationId: randomUUID(),
    idempotencyKey: incomingMessageIdempotencyKey(normalized),
    message: normalized,
  };
}
function setup() {
  const resolvePlayer = vi.fn(
    async (_input: unknown): Promise<Result<ResolvePlayerResult>> =>
      ok({ playerId, state: "COMPLETE", created: false }),
  );
  const admits = vi.fn(async (_input: unknown) => true);
  const capture: CaptureAttemptResult = {
    captureAttemptId: randomUUID(),
    encounterId: randomUUID() as EncounterId,
    battleId: null,
    status: "FAILED",
    probabilityBasisPoints: 5000,
    rollBasisPoints: 7800,
    pokemonInstanceId: null,
    placement: null,
    events: [],
    replayed: false,
  };
  const captureQuotedReply = vi.fn(
    async (_input: unknown): Promise<Result<CaptureAttemptResult>> => ok(capture),
  );
  const admission = new ExpeditionIncidentalIncomingAdmission(
    { resolvePlayer },
    { admits },
    { captureQuotedReply },
  );
  return { resolvePlayer, admits, captureQuotedReply, capture, admission };
}

describe("Normalized WhatsApp incidental capture admission SHADOW", () => {
  it("uses Baileys sender, group and quote from envelope, not from body", async () => {
    const f = setup();
    const input = message();
    expect(await f.admission.handle(input)).toEqual(ok(f.capture));
    expect(f.resolvePlayer).toHaveBeenCalledExactlyOnceWith({
      provider: "baileys",
      externalId: "5579999999999@s.whatsapp.net",
    });
    expect(f.admits).toHaveBeenCalledExactlyOnceWith({
      provider: "baileys",
      chatRef: "120363123456789@g.us",
      playerId,
    });
    expect(f.captureQuotedReply).toHaveBeenCalledExactlyOnceWith({
      playerId,
      provider: "baileys",
      chatRef: "120363123456789@g.us",
      quotedExternalMessageId: quotedId,
      rawChoice: "2",
      inboxIdempotencyKey: input.idempotencyKey,
      correlationId,
      causationId: input.causationId,
    });
  });

  it("preserves original inbox idempotency across duplicate delivery", async () => {
    const f = setup();
    const original = message();
    expect((await f.admission.handle(original)).ok).toBe(true);
    expect((await f.admission.handle(original)).ok).toBe(true);
    expect(f.captureQuotedReply).toHaveBeenCalledTimes(2);
    expect(f.captureQuotedReply.mock.calls[0]).toEqual(f.captureQuotedReply.mock.calls[1]);
  });

  it("does not steal bare numbers or commands from unrelated flows", async () => {
    const f = setup();
    for (const input of [
      message("1"),
      message("0"),
      message("capturar"),
      message("2", null),
      message("/explorar"),
    ])
      expect(await f.admission.handle(input)).toEqual(ok(null));
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    expect(f.captureQuotedReply).not.toHaveBeenCalled();
  });

  it("rejects altered inbox key, unknown/unregistered trainer and unauthorized group", async () => {
    const f = setup();
    const original = message();
    expect(
      (
        await f.admission.handle({
          ...original,
          idempotencyKey: "inbox:fake-key",
        })
      ).ok,
    ).toBe(false);
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    f.resolvePlayer.mockResolvedValueOnce(err(appError("NOT_FOUND", "No player")));
    expect((await f.admission.handle(original)).ok).toBe(false);
    f.resolvePlayer.mockResolvedValueOnce(
      ok({
        playerId,
        state: "NEW",
        created: false,
      }),
    );
    expect((await f.admission.handle(original)).ok).toBe(false);
    f.admits.mockResolvedValueOnce(false);
    expect((await f.admission.handle(original)).ok).toBe(false);
    expect(f.captureQuotedReply).not.toHaveBeenCalled();
  });

  it("rejects malformed correlation and quoted message hijack", async () => {
    const f = setup();
    const original = message();
    expect(
      (
        await f.admission.handle({
          ...original,
          correlationId: "not-uuid",
        })
      ).ok,
    ).toBe(false);
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    const badQuote = message("3", "server-menu-in-another-chat");
    f.captureQuotedReply.mockResolvedValueOnce(
      err(appError("FLOW_BLOCKED", "Quoted menu does not belong to this player/chat")),
    );
    expect((await f.admission.handle(badQuote)).ok).toBe(false);
  });
});
