import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readVerifiedExpeditionSearchEncounterPreview } from "../../src/platform/exploration/postgres-expedition-search-encounter-preview.js";

const input = {
  playerId: randomUUID(),
  areaId: randomUUID(),
  outcomeId: randomUUID(),
  encounterId: randomUUID(),
};
const good = { display_name: "Zigzagoon", level: "6", shiny: "false" };

function fixture(rows: readonly unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("V4 published canonical encounter preview", () => {
  it("reads exact persisted encounter and current PUBLISHED species revision", async () => {
    const f = fixture([good]);
    expect(await readVerifiedExpeditionSearchEncounterPreview(f.client, input)).toEqual({
      ok: true,
      value: { speciesName: "Zigzagoon", level: 6, shiny: false },
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [
      input.outcomeId,
      input.playerId,
      input.areaId,
      input.encounterId,
    ]);
    const sql = String(f.query.mock.calls[0]?.[0]);
    for (const guard of [
      "outcome.player_id=$2",
      "encounter.player_id=outcome.player_id",
      "encounter.area_id=$3",
      "encounter.status IN ('CREATED','PRESENTED')",
      "wild.status='ACTIVE'",
      "pointer.pointer_key='ACTIVE'",
      "release.status='PUBLISHED'",
      "ruleset.status='PUBLISHED'",
      "species.active=TRUE",
      "outcome.encounter_id=$4",
      "outcome.kind IN ('INCIDENTAL','DIRECT')",
    ]) {
      expect(sql).toContain(guard);
    }
    expect(sql.toUpperCase()).not.toContain("INSERT ");
    expect(sql.toUpperCase()).not.toContain("UPDATE ");
    expect(sql.toUpperCase()).not.toContain("DELETE ");
  });

  it("surfaces shiny ONLY from the canonical wild snapshot", async () => {
    const f = fixture([{ ...good, shiny: "true" }]);
    expect(await readVerifiedExpeditionSearchEncounterPreview(f.client, input)).toMatchObject({
      ok: true, value: { shiny: true },
    });
  });

  it("refuses unknown, duplicated, stale, or unauthorized encounter joins", async () => {
    for (const rows of [[], [good, good]]) {
      const f = fixture(rows);
      expect(await readVerifiedExpeditionSearchEncounterPreview(f.client, input)).toMatchObject({
        ok: false, error: { code: "FLOW_BLOCKED" },
      });
    }
  });

  it("refuses malformed published name/level/shiny rather than inventing presentation", async () => {
    const bad: readonly unknown[] = [
      { ...good, display_name: "[Ler mais]" },
      { ...good, display_name: "Zigzagoon\n0. Capturar" },
      { ...good, display_name: "Bad*mon" },
      { ...good, display_name: "" },
      { ...good, display_name: " too much whitespace " },
      { ...good, level: "0" },
      { ...good, level: "101" },
      { ...good, level: "not-an-integer" },
      { ...good, level: "1.5" },
      { ...good, shiny: "unknown" },
    ];
    for (const row of bad) {
      const f = fixture([row]);
      expect(await readVerifiedExpeditionSearchEncounterPreview(f.client, input)).toMatchObject({
        ok: false, error: { code: "FLOW_BLOCKED" },
      });
    }
  });
});
