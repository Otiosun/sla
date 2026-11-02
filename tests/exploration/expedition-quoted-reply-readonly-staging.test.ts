import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExpeditionQuotedReplyReadOnlyStagingResolver } from "../../src/modules/exploration/expedition-quoted-reply-readonly-staging.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const recipient = "5579999999999@s.whatsapp.net";
const encounterId = randomUUID();
const outcomeId = randomUUID();
const quote = randomUUID().replaceAll("-", "").toUpperCase();

function context(
  text: string,
  replyToExternalMessageId: string | null = quote,
): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:synthetic-reply",
    message: {
      provider: "baileys",
      externalMessageId: "synthetic-reply",
      senderRef: recipient,
      chatRef: recipient,
      occurredAt: "2026-11-01T23:30:00.000Z",
      text,
      replyToExternalMessageId,
      mediaRefs: [],
    },
  };
}

function setup() {
  const resolvePlayer = vi.fn(async () =>
    ok({ playerId, state: "COMPLETE" as const, created: false }),
  );
  const resolve = vi.fn(
    async (): Promise<
      Result<{
        playerId: typeof playerId;
        outcomeId: string;
        encounterId: string;
        encounterRevision: bigint;
      }>
    > => ok({ playerId, outcomeId, encounterId, encounterRevision: 2n }),
  );
  const activeForPlayer = vi.fn(
    async (): Promise<
      Result<{
        playerId: typeof playerId;
        encounterId: string;
        revision: bigint;
        status: string;
        battleId: string | null;
      }>
    > => ok({ playerId, encounterId, revision: 2n, status: "ENGAGED", battleId: null }),
  );
  const resolver = new ExpeditionQuotedReplyReadOnlyStagingResolver(
    { resolvePlayer } as unknown as ConstructorParameters<
      typeof ExpeditionQuotedReplyReadOnlyStagingResolver
    >[0],
    { resolve } as unknown as ConstructorParameters<
      typeof ExpeditionQuotedReplyReadOnlyStagingResolver
    >[1],
    { activeForPlayer } as unknown as ConstructorParameters<
      typeof ExpeditionQuotedReplyReadOnlyStagingResolver
    >[2],
  );
  return { resolver, resolvePlayer, resolve, activeForPlayer };
}

describe("V4 staging quoted reply read-only routing with authenticated player", () => {
  it.each(["0", "1", "2", "3", "4"])(
    "binds quoted numeric choice %s to its player without executing an action",
    async (selection) => {
      const f = setup();
      const routed = new MessageRouter([], undefined, f.resolver);
      const answer = await routed.dispatch(context(selection));
      expect(answer.ok).toBe(true);
      if (!answer.ok || answer.value === null) return;
      expect(f.resolvePlayer).toHaveBeenCalledExactlyOnceWith({
        provider: "baileys",
        externalId: recipient,
      });
      expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
        provider: "baileys",
        playerId,
        senderRef: recipient,
        chatRef: recipient,
        replyToExternalMessageId: quote,
      });
      expect(f.activeForPlayer).toHaveBeenCalledExactlyOnceWith(playerId);
      expect(answer.value.resultRefId).toBeNull();
      expect(answer.value.resultRefType).toBeNull();
      expect(answer.value.outgoing).toHaveLength(1);
      expect(answer.value.outgoing[0]).toMatchObject({
        destinationRef: recipient,
        channel: "whatsapp",
        messageType: "TEXT",
        idempotencyKey: "inbox:baileys:synthetic-reply:quoted-encounter-preview",
      });
      const text = String(answer.value.outgoing[0]?.payload.text);
      expect(text).toContain("nenhuma ação foi executada");
      expect(text).not.toContain(encounterId);
      expect(text).not.toContain("Poké Ball ●");
    },
  );

  it("never consumes an unquoted number or unrelated text", async () => {
    const f = setup();
    const routed = new MessageRouter([], undefined, f.resolver);
    expect(await routed.dispatch(context("1", null))).toEqual(ok(null));
    expect(await routed.dispatch(context("capturar"))).toEqual(ok(null));
    expect(await routed.dispatch(context("12"))).toEqual(ok(null));
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.activeForPlayer).not.toHaveBeenCalled();
  });

  it("refuses group replies, mismatched chat and unexpected providers before player lookup", async () => {
    const f = setup();
    const group = context("2");
    const candidates = [
      { ...group, message: { ...group.message, chatRef: "120363123456789@g.us" } },
      { ...group, message: { ...group.message, provider: "external" } },
      {
        ...group,
        message: {
          ...group.message,
          senderRef: "120363123456789@g.us",
          chatRef: "120363123456789@g.us",
        },
      },
    ];
    for (const candidate of candidates) {
      expect(await f.resolver.resolve(candidate)).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.activeForPlayer).not.toHaveBeenCalled();
  });

  it("rejects players without completed registration before reading the quote", async () => {
    const f = setup();
    f.resolvePlayer.mockResolvedValueOnce(ok({ playerId, state: "NEW" as never, created: false }));
    expect(await f.resolver.resolve(context("2"))).toMatchObject({
      ok: false,
      error: { code: "PLAYER_INELIGIBLE" },
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.activeForPlayer).not.toHaveBeenCalled();
  });

  it("rejects stale or unauthorized quoted encounter without any outgoing action", async () => {
    const f = setup();
    f.resolve.mockResolvedValueOnce(
      err(appError("FLOW_BLOCKED", "No canonical SENT/ENGAGED encounter")),
    );
    expect(await f.resolver.resolve(context("3"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(f.activeForPlayer).not.toHaveBeenCalled();
  });

  it.each([
    [{ encounterId: randomUUID() }, "another encounter"],
    [{ revision: 3n }, "changed revision"],
    [{ status: "IN_BATTLE" }, "battle started"],
    [{ battleId: randomUUID() }, "attached battle"],
    [{ playerId: createPlayerId() }, "different owner"],
  ] as const)("rejects quoted menu after %s (%s)", async (override) => {
    const f = setup();
    f.activeForPlayer.mockResolvedValueOnce(
      ok({ playerId, encounterId, revision: 2n, status: "ENGAGED", battleId: null, ...override }),
    );
    expect(await f.resolver.resolve(context("2"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(f.activeForPlayer).toHaveBeenCalledExactlyOnceWith(playerId);
  });

  it("returns a repeatable staging-only preview without any gameplay write port", async () => {
    const f = setup();
    const first = await f.resolver.resolve(context("2"));
    const replay = await f.resolver.resolve(context("2"));
    expect(replay).toEqual(first);
    if (first.ok && first.value !== null) {
      expect(first.value.outgoing).toHaveLength(1);
      expect(first.value.outgoing[0]?.payload).toHaveProperty("text");
      expect(first.value.outgoing[0]?.payload).not.toHaveProperty("expeditionSearch");
    }
  });
});
