import { describe, expect, it } from "vitest";
import type {
  EncounterTableEntryRecord,
  EncounterTableRecord,
  WildPokemonBuild,
} from "../../src/modules/encounter/contracts.js";
import { chooseWeightedEncounterEntry } from "../../src/modules/encounter/generation.js";
import type { EncounterTransaction } from "../../src/modules/encounter/ports.js";
import { resolveSearchEntries } from "../../src/modules/encounter/search-entries.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";

const parsed = parsePlayerId("00000000-0000-4000-8000-000000000001");
if (!parsed.ok) throw new Error("Invalid fixture ID");
const playerId = parsed.value;
const open = { schemaVersion: 1, requiredUnlockKeys: [], blockedUnlockKeys: [] } as const;
const entry = (id: string, weight: number): EncounterTableEntryRecord => ({
  entryId: id,
  formId: id,
  weight,
  minLevel: 2,
  maxLevel: 5,
  active: true,
  conditions: open,
});
const build = (id: string): WildPokemonBuild => ({
  formId: id,
  speciesId: id.startsWith("target") ? "known" : "other",
  type1Id: "normal",
  type2Id: null,
  baseStats: { hp: 40, attack: 40, defense: 40, spAttack: 40, spDefense: 40, speed: 40 },
  abilityIds: ["ability"],
  natureIds: ["nature"],
  moves: [],
});
function fixture(
  entries = [entry("target-a", 10), entry("other", 90)],
  known: string | null = "known",
) {
  const table: EncounterTableRecord = {
    encounterTableId: "table",
    slug: "land",
    active: true,
    conditions: open,
    entries,
  };
  const tx: Pick<EncounterTransaction, "tables" | "knownSpecies" | "wildBuild"> = {
    tables: async () => [table],
    knownSpecies: async () => known,
    wildBuild: async (_release, id) => build(id),
  };
  return {
    table,
    tx,
    context: {
      playerActive: true,
      onboardingComplete: true,
      areaId: "area",
      activeBattle: false,
      unlockKeys: [],
    },
    input: {
      playerId,
      idempotencyKey: "search",
      searchTarget: { speciesSlug: "known" },
      environment: { timeOfDay: "DAY" as const, surface: "LAND" as const },
    },
  };
}
describe("known, eligible directed search", () => {
  it("triples only the target and draws 25% from a 10% base without mutating the published pool", async () => {
    const f = fixture();
    const result = await resolveSearchEntries(f.tx, "release", f.context, f.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((e) => e.weight)).toEqual([30, 90]);
    expect(f.table.entries.map((e) => e.weight)).toEqual([10, 90]);
    let hits = 0;
    for (let roll = 0; roll < 120; roll++) {
      const selected = chooseWeightedEncounterEntry(result.value, {
        randomInt: () => roll,
        randomFloat: () => 0,
      });
      if (selected.entryId === "target-a") hits++;
    }
    expect(hits).toBe(30);
  });
  it("supports all eligible forms of the same species and has no 50% cap", async () => {
    const f = fixture([entry("target-a", 15), entry("target-b", 15), entry("other", 70)]);
    const r = await resolveSearchEntries(f.tx, "release", f.context, f.input);
    expect(r.ok && r.value.map((e) => e.weight)).toEqual([45, 45, 70]);
  });
  it.each([null, "absent"])(
    "does not reveal or authorize unknown/out-of-area target %s",
    async (known) => {
      const f = fixture(undefined, known);
      expect((await resolveSearchEntries(f.tx, "release", f.context, f.input)).ok).toBe(false);
    },
  );
  it.each(["inactive", "night", "water", "locked"])(
    "rejects a known target excluded by %s",
    async (reason) => {
      const target = entry("target-a", 10);
      const excluded = {
        ...target,
        active: reason !== "inactive",
        conditions: {
          ...open,
          ...(reason === "night" ? { timeOfDay: "NIGHT" as const } : {}),
          ...(reason === "water" ? { surface: "WATER" as const } : {}),
          ...(reason === "locked" ? { requiredUnlockKeys: ["event.secret"] } : {}),
        },
      };
      const f = fixture([excluded, entry("other", 90)]);
      expect((await resolveSearchEntries(f.tx, "release", f.context, f.input)).ok).toBe(false);
    },
  );
  it("retains ordinary weights when following a validated target trail", async () => {
    const f = fixture([entry("target-a", 10), entry("target-b", 20), entry("other", 70)]);
    const r = await resolveSearchEntries(f.tx, "release", f.context, {
      ...f.input,
      searchTarget: { speciesSlug: "known", followTrail: true },
    });
    expect(r.ok && r.value.map((e) => [e.formId, e.weight])).toEqual([
      ["target-a", 10],
      ["target-b", 20],
    ]);
  });
  it("rejects arithmetic overflow and ambiguous tables rather than creating a new pool", async () => {
    const f = fixture([entry("target-a", Number.MAX_SAFE_INTEGER)]);
    expect((await resolveSearchEntries(f.tx, "release", f.context, f.input)).ok).toBe(false);
    f.tx.tables = async () => [f.table, { ...f.table, slug: "another" }];
    expect((await resolveSearchEntries(f.tx, "release", f.context, f.input)).ok).toBe(false);
  });
});
