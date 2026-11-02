import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresExpeditionIgnoreConfirmationRecovery } from "../../src/platform/exploration/postgres-expedition-ignore-confirmation-recovery.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";

const playerId = createPlayerId();
const outcomeId = randomUUID();
const encounterId = randomUUID();
const fingerprint = createHash("sha256")
  .update(JSON.stringify(["ACTION_IGNORE_INCIDENTAL", outcomeId, encounterId, "2", 10]))
  .digest("hex");
const row = {
  encounter_id: encounterId,
  outcome_id: outcomeId,
  encounter_revision: "2",
  fingerprint,
  elapsed_minutes: "40",
  effect_ref: encounterId,
};
function context(): MessageHandlerContext {
  const senderRef = "5579999999999@s.whatsapp.net";
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:ignored-once",
    message: {
      provider: "baileys",
      externalMessageId: "ignored-once",
      senderRef,
      chatRef: senderRef,
      occurredAt: "2026-11-02T18:00:00.000Z",
      text: "0",
      replyToExternalMessageId: randomUUID().replaceAll("-", "").toUpperCase(),
      mediaRefs: [],
    },
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("offline ignore: post-commit confirmation recovery is read-only", () => {
  it("requires the exact Inbox, SENT menu, fingerprint, receipt and encounter FLED", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const query = vi.fn(async () => ({ rows: [row] }));
    const proof = new PostgresExpeditionIgnoreConfirmationRecovery({ query } as never);
    const ctx = context();
    expect(await proof.resolve({ playerId, context: ctx })).toEqual({
      ok: true,
      value: { encounterId, elapsedMinutes: 40 },
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("receipt.operation='ACTION_IGNORE_INCIDENTAL'");
    expect(sql).toContain("encounter.status='FLED'");
    expect(sql).toContain("outbound.status='SENT'");
    expect(sql).toContain("outbound.payload->'expeditionMenu'->'actions'=menu.panel->'actions'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ctx.inboxMessageId,
      playerId,
      ctx.idempotencyKey,
      expect.any(String),
      ctx.message.senderRef,
      ctx.message.externalMessageId,
      ctx.message.replyToExternalMessageId,
    ]);
  });

  it("denies mismatched receipt or malformed duration, without any write", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    for (const wrong of [
      { ...row, fingerprint: "f".repeat(64) },
      { ...row, effect_ref: randomUUID() },
      { ...row, elapsed_minutes: "0" },
      { ...row, elapsed_minutes: "not-a-number" },
    ]) {
      const proof = new PostgresExpeditionIgnoreConfirmationRecovery({
        query: vi.fn(async () => ({ rows: [wrong] })),
      } as never);
      expect(await proof.resolve({ playerId, context: context() })).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("never reads SQL in production or for untrusted group/choice/quote", async () => {
    const query = vi.fn();
    const proof = new PostgresExpeditionIgnoreConfirmationRecovery({ query } as never);
    const ctx = context();
    for (const mode of ["production", "staging"]) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("WHATSAPP_ENABLED", "false");
      expect(await proof.resolve({ playerId, context: ctx })).toEqual({ ok: true, value: null });
    }
    vi.stubEnv("APP_ENV", "test");
    for (const message of [
      { ...ctx.message, chatRef: "12036311111111@g.us" },
      { ...ctx.message, text: "1" },
      { ...ctx.message, replyToExternalMessageId: null },
    ]) {
      expect(await proof.resolve({ playerId, context: { ...ctx, message } })).toEqual({
        ok: true,
        value: null,
      });
    }
    expect(query).not.toHaveBeenCalled();
  });
});
