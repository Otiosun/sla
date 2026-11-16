import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresExpeditionBattleConfirmationRecovery } from "../../src/platform/exploration/postgres-expedition-battle-confirmation-recovery.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { incomingMessageFingerprint } from "../../src/modules/messaging/contracts.js";

const playerId = createPlayerId();
const outcomeId = randomUUID();
const encounterId = randomUUID();
const menuId = randomUUID();
const battleId = randomUUID();
function context(): MessageHandlerContext {
  const senderRef = "5579999999999@s.whatsapp.net";
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:one-claim",
    message: {
      provider: "baileys",
      externalMessageId: "one-claim",
      senderRef,
      chatRef: senderRef,
      occurredAt: "2026-11-02T18:00:00.000Z",
      text: "1",
      replyToExternalMessageId: randomUUID().replaceAll("-", "").toUpperCase(),
      mediaRefs: [],
    },
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("offline PvE post-commit confirmation recovery", () => {
  it("requires committed receipt and exact Inbox, SENT quote and initialized battle", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const ctx = context();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          playerId,
          outcomeId,
          encounterId,
          "2",
          menuId,
          ctx.inboxMessageId,
          incomingMessageFingerprint(ctx.message),
          ctx.message.senderRef,
        ]),
      )
      .digest("hex");
    const row = {
      menu_id: menuId,
      outcome_id: outcomeId,
      encounter_id: encounterId,
      encounter_revision: "2",
      battle_id: battleId,
      fingerprint,
    };
    const query = vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows: [row] }));
    const recovery = new PostgresExpeditionBattleConfirmationRecovery({ query } as never);
    expect(await recovery.resolve({ playerId, context: ctx })).toEqual({
      ok: true,
      value: { battleId },
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("receipt.inbox_message_id=$3");
    expect(sql).toContain("battle_state_snapshots");
    expect(sql).toContain("outbound.status='SENT'");
    expect(sql).toContain("outbound.payload->'expeditionMenu'->'actions'=menu.panel->'actions'");
    const rejected = new PostgresExpeditionBattleConfirmationRecovery({
      query: vi.fn(async () => ({ rows: [{ ...row, fingerprint: "f".repeat(64) }] })),
    } as never);
    expect(await rejected.resolve({ playerId, context: ctx })).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("requires offline test and private unmodified battle reply before reading", async () => {
    const query = vi.fn();
    const recovery = new PostgresExpeditionBattleConfirmationRecovery({ query } as never);
    const ctx = context();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    expect(await recovery.resolve({ playerId, context: ctx })).toEqual({ ok: true, value: null });
    vi.stubEnv("APP_ENV", "test");
    for (const message of [
      { ...ctx.message, text: "0" },
      { ...ctx.message, chatRef: "12345@g.us" },
      { ...ctx.message, replyToExternalMessageId: null },
    ]) {
      expect(await recovery.resolve({ playerId, context: { ...ctx, message } })).toEqual({
        ok: true,
        value: null,
      });
    }
    expect(query).not.toHaveBeenCalled();
  });
});
