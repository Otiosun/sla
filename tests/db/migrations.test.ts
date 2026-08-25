import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MigrationIntegrityError,
  loadMigrations,
  sha256Hex,
} from "../../src/platform/db/migrations.js";

const temporaryDirectories: string[] = [];

async function createMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-rpg-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("migration discovery", () => {
  it("fails closed when no numbered migration exists", async () => {
    const directory = await createMigrationDirectory();
    await expect(loadMigrations(directory)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it("rejects SQL files whose names do not obey the migration contract", async () => {
    const directory = await createMigrationDirectory();
    await writeFile(join(directory, "0001_core.sql"), "SELECT 1;\n");
    await writeFile(join(directory, "0002-bad-name.sql"), "SELECT 2;\n");
    await expect(loadMigrations(directory)).rejects.toThrow(/Malformed SQL migration filename/);
  });

  it("rejects a sequence that does not begin at 0001", async () => {
    const directory = await createMigrationDirectory();
    await writeFile(join(directory, "0002_gap.sql"), "SELECT 2;\n");
    await expect(loadMigrations(directory)).rejects.toThrow(/expected 0001/);
  });

  it("loads contiguous migrations with the exact SHA-256 of their bytes", async () => {
    const directory = await createMigrationDirectory();
    const sql = "SELECT 1;\n";
    await writeFile(join(directory, "0001_core.sql"), sql);

    const migrations = await loadMigrations(directory);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      version: 1n,
      versionText: "0001",
      name: "core",
      fileName: "0001_core.sql",
      checksum: sha256Hex(sql),
    });
  });
});
