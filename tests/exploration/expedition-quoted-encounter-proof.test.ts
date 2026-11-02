import { describe, expect, it, vi } from "vitest";
import { PostgresExpeditionQuotedEncounterProof } from "../../src/platform/exploration/postgres-expedition-quoted-encounter-proof.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const playerId = createPlayerId();
const senderRef = "5579999999999@s.whatsapp.net";
const quote = "0123456789ABCDEF0123456789ABCDEF";
const row = {
  player_id: playerId,
  outcome_id: "00000000-0000-4000-8000-000000000123",
  encounter_id: "00000000-0000-4000-8000-000000000122",
  revision: "2",
};

function fixture(rows: unknown[] = [row]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
  const proof = new PostgresExpeditionQuotedEncounterProof({
    query,
  } as unknown as ConstructorParameters<typeof PostgresExpeditionQuotedEncounterProof>[0]);
  return { proof, query };
}

const request = {
  provider: "baileys",
  playerId,
  senderRef,
  chatRef: senderRef,
  replyToExternalMessageId: quote,
};

describe("staging-only private expedition quoted reply proof", () => {
  it("only reads a matching SENT and ENGAGED result with canonical owner", async () => {
    const { proof, query } = fixture();
    const result = await proof.resolve(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      playerId,
      outcomeId: row.outcome_id,
      encounterId: row.encounter_id,
      encounterRevision: 2n,
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("encounter.status = 'ENGAGED'");
    expect(sql).toContain("outbox.status = 'SENT'");
    expect(sql).toContain("outbox.sent_at IS NOT NULL");
    expect(sql).toContain("outbox.destination_ref = $2");
    expect(sql).toContain("upper(replace(outbox.id::text, '-', '')) = upper($1)");
    expect(sql).toContain("encounter.player_id = outcome.player_id");
  });

  it.each([
    { ...request, replyToExternalMessageId: null },
    { ...request, replyToExternalMessageId: "bad-quote" },
    { ...request, senderRef: "120363123@g.us", chatRef: "120363123@g.us" },
    { ...request, chatRef: "120363123@g.us" },
    { ...request, provider: "other" },
  ])("fails closed before DB on invalid private quote", async (input) => {
    const { proof, query } = fixture();
    expect((await proof.resolve(input)).ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on missing, duplicate or different-owner matches", async () => {
    for (const rows of [[], [row, row], [{ ...row, player_id: createPlayerId() }]]) {
      const { proof } = fixture(rows);
      expect((await proof.resolve(request)).ok).toBe(false);
    }
  });

  it("does not trust invalid persisted ids or encounter revisions", async () => {
    for (const invalid of [
      { ...row, outcome_id: "invalid" },
      { ...row, encounter_id: "invalid" },
      { ...row, revision: "-1" },
    ]) {
      const { proof } = fixture([invalid]);
      expect((await proof.resolve(request)).ok).toBe(false);
    }
  });
});
