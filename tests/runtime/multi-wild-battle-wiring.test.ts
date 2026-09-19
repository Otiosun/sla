import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("canonical multi-wild battle wiring", () => {
  it("loads active encounter wild snapshots into the battle opponent party", () => {
    const source = fs.readFileSync("src/platform/battle/postgres-battle-repository.ts", "utf8");

    expect(source).toContain("FROM encounter_wild_snapshots");
    expect(source).toContain("WHERE encounter_id = $1 AND status = 'ACTIVE'");
    expect(source).toContain("wildRoster.map((wild)");
    expect(source).toContain("wild.wildNo");
  });

  it("keeps encounter_snapshots as compatibility mirror while persisting the roster", () => {
    const source = fs.readFileSync(
      "src/platform/encounter/postgres-encounter-repository.ts",
      "utf8",
    );

    expect(source).toContain("INSERT INTO encounter_snapshots");
    expect(source).toContain("INSERT INTO encounter_wild_snapshots");
  });
});
