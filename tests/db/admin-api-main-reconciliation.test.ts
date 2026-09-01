import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url);

function migrationVersion(fileName: string): string | null {
  const match = /^(\d{4})_.*\.sql$/.exec(fileName);
  return match?.[1] ?? null;
}

describe("Admin API reconciliation migration contract", () => {
  test("keeps runtime 0026 canonical and places Admin API migrations after it", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((fileName) => fileName.endsWith(".sql"));
    const versions = files.map(migrationVersion).filter((value): value is string => value !== null);

    expect(files).toContain("0026_runtime_health_evidence.sql");
    expect(files).toContain("0027_admin_api_rate_limit_buckets.sql");
    expect(files).toContain("0028_admin_api_mutation_prepare_rate_limit.sql");
    expect(files).not.toContain("0026_admin_api_rate_limit_buckets.sql");
    expect(files).not.toContain("0027_admin_api_mutation_prepare_rate_limit.sql");
    expect(new Set(versions).size).toBe(versions.length);
  });
});
