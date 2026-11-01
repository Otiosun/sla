import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresExpeditionSearchSentProof } from "../../src/platform/exploration/postgres-expedition-search-sent-proof.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const playerId = createPlayerId();
const input = {
  playerId,
  outcomeId: randomUUID(),
  encounterId: randomUUID(),
  outboxMessageId: randomUUID(),
  destinationRef: "5579999999999@s.whatsapp.net",
};
const row = {
  player_id: playerId,
  encounter_id: input.encounterId,
  area_id: randomUUID(),
  revision: "0",
  status: "CREATED" as const,
};

function setup(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows }));
  const proof = new PostgresExpeditionSearchSentProof({
    query,
  } as unknown as Pick<Pool, "query">);
  return { query, proof };
}

describe("post-SENT V4 search proof (never accepts pre-send binding)", () => {
  it("requires an exact SENT, private, server-anchored outcome and canonical Encounter", async () => {
    const f = setup([row]);
    const result = await f.proof.confirm(input);
    expect(result).toMatchObject({
      ok: true,
      value: {
        playerId,
        encounterId: input.encounterId,
        outcomeId: input.outcomeId,
        encounterStatus: "CREATED",
        encounterRevision: 0n,
      },
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [
      input.outboxMessageId,
      input.outcomeId,
      playerId,
      input.encounterId,
      input.destinationRef,
    ]);
    const sql = String(f.query.mock.calls[0]?.[0]);
    for (const clause of [
      "outbox.status='SENT'",
      "outbox.sent_at IS NOT NULL",
      "outbox.destination_ref=$5",
      "outbox.channel='whatsapp'",
      "outbox.message_type='TEXT'",
      "outbox.payload->'expeditionSearch'->>'playerId'=$3",
      "outbox.payload->'expeditionSearch'->>'outcomeId'=$2",
      "outbox.payload->'expeditionSearch'->>'encounterId'=$4",
      "outcome.player_id=$3",
      "outcome.encounter_id=$4",
      "outcome.kind IN ('DIRECT','INCIDENTAL')",
      "encounter.player_id=outcome.player_id",
      "encounter.area_id=expedition.area_id",
      "encounter.status IN ('CREATED','PRESENTED','ENGAGED')",
      "pointer.pointer_key='ACTIVE'",
      "release.status='PUBLISHED'",
    ]) {
      expect(sql).toContain(clause);
    }
    expect(sql).not.toContain("solo_incidental_menu_deliveries");
    expect(sql.toUpperCase()).not.toContain("UPDATE ");
    expect(sql.toUpperCase()).not.toContain("INSERT ");
    expect(sql.toUpperCase()).not.toContain("DELETE ");
  });

  it("fails closed on no row, multiple rows, foreign owner or different Encounter", async () => {
    for (const rows of [
      [],
      [row, row],
      [{ ...row, player_id: createPlayerId() }],
      [{ ...row, encounter_id: randomUUID() }],
      [{ ...row, status: "FLED" }],
      [{ ...row, revision: "-1" }],
      [{ ...row, revision: "not-a-revision" }],
    ]) {
      const f = setup(rows);
      expect(await f.proof.confirm(input)).toMatchObject({
        ok: false,
        error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("rejects malformed trusted identifiers before issuing SQL", async () => {
    for (const invalid of [
      { ...input, outcomeId: "not-a-uuid" },
      { ...input, encounterId: "0" },
      { ...input, outboxMessageId: "" },
      { ...input, destinationRef: "" },
    ]) {
      const f = setup([row]);
      expect(await f.proof.confirm(invalid)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
      expect(f.query).not.toHaveBeenCalled();
    }
  });

  it.each([
    "120363123456789@g.us",
    "status@broadcast",
    "1234567890@broadcast",
    "1234567890@newsletter",
    "1234567890@c.us",
    "1234567890@random.host",
    "1234567890@s.whatsapp.net\\n",
    "1234567890@s.whatsapp.net ",
    "1234567890:4@s.whatsapp.net",
    "1234@s.whatsapp.net",
    "not-a-phone@s.whatsapp.net",
    "1234567890",
  ])(
    "rejects nonprivate or untrusted WhatsApp destination %s BEFORE SQL",
    async (destinationRef) => {
      const f = setup([row]);
      expect(await f.proof.confirm({ ...input, destinationRef })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it.each(["5579999999999@s.whatsapp.net", "123456789012345@lid"])(
    "permits direct user/LID destination %s with the exact SENT proof",
    async (destinationRef) => {
      const f = setup([row]);
      expect(await f.proof.confirm({ ...input, destinationRef })).toMatchObject({
        ok: true,
        value: { encounterId: input.encounterId, encounterStatus: "CREATED" },
      });
      expect(f.query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [
        input.outboxMessageId,
        input.outcomeId,
        playerId,
        input.encounterId,
        destinationRef,
      ]);
    },
  );

  it("returns SENT proof for already ENGAGED encounter without mutating its state", async () => {
    const f = setup([{ ...row, status: "ENGAGED", revision: "2" }]);
    expect(await f.proof.confirm(input)).toMatchObject({
      ok: true,
      value: { encounterStatus: "ENGAGED", encounterRevision: 2n },
    });
  });
});
