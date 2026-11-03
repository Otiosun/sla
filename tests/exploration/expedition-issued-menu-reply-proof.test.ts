import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresExpeditionIssuedMenuReplyProof } from "../../src/platform/exploration/postgres-expedition-issued-menu-reply-proof.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const playerId = createPlayerId();
const senderRef = "5579999999999@s.whatsapp.net";
const quoted = randomUUID().replaceAll("-", "").toUpperCase();
const menuId = randomUUID();
const outcomeId = randomUUID();
const encounterId = randomUUID();
const ballId = randomUUID();
const validRow = {
  menu_id: menuId,
  player_id: playerId,
  outcome_id: outcomeId,
  encounter_id: encounterId,
  encounter_revision: "2",
  ball_item_ids: { "2": ballId },
};
const request = {
  provider: "baileys",
  playerId,
  senderRef,
  chatRef: senderRef,
  replyToExternalMessageId: quoted,
};

function setup(rows: unknown[] = [validRow]) {
  const query = vi.fn(async (_sql: string, _args: unknown[]) => ({ rows }));
  const proof = new PostgresExpeditionIssuedMenuReplyProof({
    query,
  } as unknown as ConstructorParameters<typeof PostgresExpeditionIssuedMenuReplyProof>[0]);
  return { proof, query };
}

describe("isolated issued menu proof binds quote, player and immutable Ball IDs", () => {
  it("denies a forged ACTIONABLE menu whose text or choices diverge from the sent Outbox", async () => {
    const good = {
      ...validRow,
      menu_mode: "ACTIONABLE",
      menu_text: "2. Poké Ball ×1",
      outbox_text: "2. Poké Ball ×1",
      menu_actions: ["CAPTURE"],
      outbox_actions: ["CAPTURE"],
      outbox_balls: { "2": ballId },
      capture_enabled: true,
      battle_enabled: false,
      ignore_enabled: false,
    };
    const accepted = setup([good]);
    expect(await accepted.proof.resolve(request)).toMatchObject({
      ok: true,
      value: { actionable: true, captureEnabled: true, battleEnabled: false, ignoreEnabled: false },
    });
    const sql = String(accepted.query.mock.calls[0]?.[0]);
    expect(sql).toContain("menu.panel->'actions' = outbox.payload->'expeditionMenu'->'actions'");
    expect(sql).toContain("menu.ball_item_ids = outbox.payload->'expeditionMenu'->'ballItemIds'");
    expect(sql).toContain("menu.panel->>'text' = outbox.payload->>'text'");
    for (const forged of [
      { ...good, outbox_text: "Somente prévia" },
      { ...good, outbox_actions: ["CAPTURE", "BATTLE"] },
      { ...good, outbox_balls: { "2": randomUUID() } },
      { ...good, menu_actions: ["CAPTURE", "CAPTURE"] },
      { ...good, menu_actions: ["CAPTURE", "IGNITE"] },
    ]) {
      expect(await setup([forged]).proof.resolve(request)).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("accepts only the persisted menu mapping, never a client-supplied item ID", async () => {
    const { proof, query } = setup();
    expect(await proof.resolve(request)).toEqual({
      ok: true,
      value: {
        menuId,
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballId },
      },
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("outbox.status = 'SENT'");
    expect(sql).toContain("encounter.status = 'ENGAGED'");
    expect(sql).toContain("encounter.revision = menu.encounter_revision");
    expect(sql).toContain("solo_incidental_menu_deliveries");
    expect(sql).toContain("NOT EXISTS");
    expect(query.mock.calls[0]?.[1]).toEqual(["baileys", senderRef, quoted, playerId]);
  });

  it.each([
    { ...request, provider: "not-baileys" },
    { ...request, chatRef: "120363111111@g.us" },
    { ...request, senderRef: "120363111111@g.us", chatRef: "120363111111@g.us" },
    { ...request, replyToExternalMessageId: null },
    { ...request, replyToExternalMessageId: "invalid" },
  ])("denies untrusted quote context before SQL", async (input) => {
    const { proof, query } = setup();
    expect((await proof.resolve(input)).ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("blocks absent, ambiguous or corrupted server-issued menus", async () => {
    const cases: unknown[][] = [
      [],
      [validRow, validRow],
      [{ ...validRow, player_id: createPlayerId() }],
      [{ ...validRow, encounter_revision: "-2" }],
      [{ ...validRow, ball_item_ids: { "2": "not-uuid" } }],
      [{ ...validRow, ball_item_ids: { "1": ballId } }],
      [{ ...validRow, ball_item_ids: { "2": ballId, "3": ballId } }],
      [{ ...validRow, ball_item_ids: [] }],
    ];
    for (const rows of cases) {
      const { proof } = setup(rows);
      expect((await proof.resolve(request)).ok).toBe(false);
    }
  });
});
