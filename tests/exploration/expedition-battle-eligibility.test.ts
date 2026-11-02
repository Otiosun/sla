import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readOfflineExpeditionBattleEligibility } from "../../src/platform/exploration/postgres-expedition-battle-eligibility.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const owner = createPlayerId();
const encounterId = randomUUID();
const releaseId = randomUUID();
const pokemonId = randomUUID();
const ready = {
  pokemon_instance_id: pokemonId,
  current_hp: 20,
  status: "ACTIVE",
  form_id: randomUUID(),
  nature_id: randomUUID(),
  nature_revision_id: randomUUID(),
  ability_id: randomUUID(),
  ability_revision_id: randomUUID(),
  move_count: 1,
  published_move_count: 1,
  major_conditions: 0,
};
function fixture(frozen: unknown, team: unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[]) => ({
    rows: query.mock.calls.length === 1 ? frozen : team,
  }));
  return {
    query,
    read: () =>
      readOfflineExpeditionBattleEligibility(
        { query } as never,
        { playerId: owner, encounterId, contentReleaseId: releaseId },
      ),
  };
}
describe("offline PvE preflight uses only frozen canonical encounter roster", () => {
  it("accepts one published, healthy party member with moves, nature and ability", async () => {
    const item = fixture([{ pokemon_instance_ids: [pokemonId] }], [ready]);
    expect(await item.read()).toBe(true);
    expect(item.query.mock.calls).toHaveLength(2);
    const sql = String(item.query.mock.calls[1]?.[0]);
    expect(sql).toContain("pokemon_move_slots");
    expect(sql).toContain("pokemon_form_revisions");
    expect(sql).toContain("pokemon_training_values");
    expect(sql).toContain("pokemon_persistent_conditions");
  });

  it("fails closed on absent/multiple/empty/duplicate/future roster snapshots", async () => {
    for (const roster of [
      [],
      [{ pokemon_instance_ids: null }],
      [{ pokemon_instance_ids: [] }],
      [{ pokemon_instance_ids: [pokemonId, pokemonId] }],
      [{ pokemon_instance_ids: Array.from({ length: 7 }, () => randomUUID()) }],
      [{ pokemon_instance_ids: [pokemonId] }, { pokemon_instance_ids: [pokemonId] }],
    ]) {
      const item = fixture(roster, [ready]);
      expect(await item.read()).toBe(false);
      expect(item.query).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects unready party members, including stale catalog moves and fainted teams", async () => {
    for (const bad of [
      { ...ready, current_hp: 0 },
      { ...ready, status: "BOXED" },
      { ...ready, form_id: null },
      { ...ready, nature_revision_id: null },
      { ...ready, ability_revision_id: null },
      { ...ready, move_count: 0, published_move_count: 0 },
      { ...ready, move_count: 2, published_move_count: 1 },
      { ...ready, major_conditions: 2 },
    ]) {
      expect(await fixture([{ pokemon_instance_ids: [pokemonId] }], [bad]).read()).toBe(false);
    }
  });
});
