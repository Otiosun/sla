import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresExpeditionOfflineBattleStart } from "../../src/platform/exploration/postgres-expedition-offline-battle-start.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

afterEach(() => vi.unstubAllEnvs());

describe("isolated offline atomic PvE start: production hard gate", () => {
  it.each([
    { app: "production", node: "test", whatsapp: "false" },
    { app: "test", node: "production", whatsapp: "false" },
    { app: "test", node: "test", whatsapp: "true" },
  ])("rejects $app/$node/$whatsapp before opening a transaction", async (mode) => {
    vi.stubEnv("APP_ENV", mode.app);
    vi.stubEnv("NODE_ENV", mode.node);
    vi.stubEnv("WHATSAPP_ENABLED", mode.whatsapp);
    const connect = vi.fn();
    const action = new PostgresExpeditionOfflineBattleStart(
      { connect } as unknown as Pool,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(
      await action.execute({
        playerId: createPlayerId(),
        encounterId: "e558ca54-509c-4f78-8602-123456789abc",
        outcomeId: "e558ca54-509c-4f78-8602-123456789abe",
        menuId: "e558ca54-509c-4f78-8602-123456789abf",
        expectedEncounterRevision: 2n,
        inboxMessageId: "e558ca54-509c-4f78-8602-123456789abd",
        idempotencyKey: "offline-pve",
        messageFingerprint: "a".repeat(64),
        senderRef: "5579999999999@s.whatsapp.net",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(connect).not.toHaveBeenCalled();
  });
});
