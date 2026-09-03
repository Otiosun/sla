import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresContentAnalyticsRepository } from "../../src/platform/admin/postgres-content-analytics-repository.js";

describe("PostgresContentAnalyticsRepository query shape", () => {
  it("keeps encounter and capture temporal aggregates independently indexable", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM encounters")) {
          return { rows: [{ created: "0", closed: "0" }] };
        }
        if (sql.includes("FROM capture_attempts")) {
          return { rows: [{ attempts_created: "0", captured: "0", failed: "0" }] };
        }
        if (sql.includes("FROM pokemon_xp_ledger")) {
          return { rows: [{ xp_awards: "0", xp_awarded: "0" }] };
        }
        if (sql.includes("FROM pokemon_evolution_claims")) {
          return { rows: [{ evolutions: "0" }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    await new PostgresContentAnalyticsRepository(pool).readAggregate(
      "production",
      new Date("2026-09-03T12:00:00.000Z"),
    );

    const encounterSql = statements.find((sql) => sql.includes("FROM encounters"));
    const captureSql = statements.find((sql) => sql.includes("FROM capture_attempts"));
    expect(encounterSql).toBeDefined();
    expect(captureSql).toBeDefined();
    if (encounterSql === undefined || captureSql === undefined) {
      throw new Error("Content analytics aggregate SQL was not observed");
    }

    expect(encounterSql.match(/FROM encounters/g)).toHaveLength(2);
    expect(encounterSql).toContain("WHERE created_at >=");
    expect(encounterSql).toContain("WHERE closed_at >=");

    expect(captureSql.match(/FROM capture_attempts/g)).toHaveLength(3);
    expect(captureSql).toContain("WHERE created_at >=");
    expect(captureSql).toContain("WHERE status = 'CAPTURED'");
    expect(captureSql).toContain("WHERE status = 'FAILED'");
  });
});
