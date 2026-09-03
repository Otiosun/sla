import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contractsPath = fileURLToPath(
  new URL("../../src/modules/admin/player360-contracts.ts", import.meta.url),
);
const repositoryPath = fileURLToPath(
  new URL("../../src/platform/admin/postgres-player360-repository.ts", import.meta.url),
);

describe("Player 360 active encounter revision contract", () => {
  it("carries the authoritative encounter revision from PostgreSQL into the read model", async () => {
    const [contracts, repository] = await Promise.all([
      readFile(contractsPath, "utf8"),
      readFile(repositoryPath, "utf8"),
    ]);

    expect(contracts).toMatch(
      /export interface Player360EncounterView \{[\s\S]*?readonly revision: string;[\s\S]*?\}/,
    );
    expect(repository).toContain("encounter_revision: string;");
    expect(repository).toContain("revision::text AS encounter_revision");
    expect(repository).toContain("revision: encounterRow.encounter_revision");
  });
});
