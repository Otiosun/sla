import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresExpeditionCaptureConfirmationRecovery } from "../../src/platform/exploration/postgres-expedition-capture-confirmation-recovery.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";

const playerId = createPlayerId();
const senderRef = "5579999999999@s.whatsapp.net";
const outboxId = randomUUID().replaceAll("-", "").toUpperCase();

function context(input?: {
  readonly text?: string;
  readonly senderRef?: string;
  readonly chatRef?: string;
  readonly quote?: string | null;
}): MessageHandlerContext {
  const sender = input?.senderRef ?? senderRef;
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:recovery-proof",
    message: {
      provider: "baileys",
      externalMessageId: "recovery-proof",
      senderRef: sender,
      chatRef: input?.chatRef ?? sender,
      occurredAt: "2026-11-02T02:00:00.000Z",
      text: input?.text ?? "2",
      replyToExternalMessageId: input?.quote === undefined ? outboxId : input.quote,
      mediaRefs: [],
    },
  };
}

function fixture(rows: unknown[] = [{ encounter_id: randomUUID(), status: "CAPTURED" }]) {
  const query = vi.fn(async (_sql: string, _args: unknown[]) => ({ rows }));
  const recovery = new PostgresExpeditionCaptureConfirmationRecovery({
    query,
  } as unknown as ConstructorParameters<typeof PostgresExpeditionCaptureConfirmationRecovery>[0]);
  return { query, recovery };
}

describe("post-commit capture confirmation recovery", () => {
  it("uses the exact claimed Inbox fingerprint, original Ball, SENT menu and canonical attempt", async () => {
    const f = fixture();
    const input = context();
    const recovered = await f.recovery.resolve({ playerId, context: input });
    expect(recovered).toMatchObject({ ok: true, value: { status: "CAPTURED" } });
    expect(f.query).toHaveBeenCalledTimes(1);
    const sql = String(f.query.mock.calls[0]?.[0]);
    for (const token of [
      "inbox.status = 'PROCESSING'",
      "inbox.payload_hash = $4",
      "attempt.idempotency_key = $3",
      "attempt.correlation_id = inbox.correlation_id",
      "attempt.status IN ('CAPTURED','FAILED')",
      "menu.ball_item_ids->>$7 = attempt.ball_item_id::text",
      "outbound.status = 'SENT'",
      "outbound.payload->'expeditionMenu'->>'mode' = 'ACTIONABLE'",
    ]) {
      expect(sql).toContain(token);
    }
    expect(f.query.mock.calls[0]?.[1]).toEqual([
      input.inboxMessageId,
      playerId,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      senderRef,
      "recovery-proof",
      "2",
    ]);
  });

  it.each([
    { text: "1" },
    { text: "0" },
    { text: "34" },
    { text: "capture" },
    { quote: null },
    { quote: "forged-quote" },
    { chatRef: "12036322222@g.us" },
    { senderRef: "12036322222@g.us" },
  ])("does not access capture records for an invalid private Ball reply", async (change) => {
    const f = fixture();
    expect(await f.recovery.resolve({ playerId, context: context(change) })).toEqual({
      ok: true,
      value: null,
    });
    expect(f.query).not.toHaveBeenCalled();
  });

  it("does not invent a confirmation if no resolved attempt is bound to this Inbox", async () => {
    const f = fixture([]);
    expect(await f.recovery.resolve({ playerId, context: context() })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("fails closed for ambiguous or invalid recovered capture status", async () => {
    for (const rows of [
      [
        { encounter_id: randomUUID(), status: "CAPTURED" },
        { encounter_id: randomUUID(), status: "FAILED" },
      ],
      [{ encounter_id: randomUUID(), status: "PENDING" }],
    ]) {
      const f = fixture(rows);
      expect(await f.recovery.resolve({ playerId, context: context() })).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("can recover a resolved failed throw without another item consumption", async () => {
    const f = fixture([{ encounter_id: randomUUID(), status: "FAILED" }]);
    expect(await f.recovery.resolve({ playerId, context: context({ text: "4" }) })).toMatchObject({
      ok: true,
      value: { status: "FAILED" },
    });
  });
});
