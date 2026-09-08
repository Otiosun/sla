import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("Fishing optional rarity pool schema", () => {
  const dbName = `pokemon_fishing_optional_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 2 });
    await runMigrations(pool, { appliedBy: "fishing-optional-rarity-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("allows durable RARE and EXTREMELY_RARE attempts without an encounter table", async () => {
    const client = await pool.connect();
    try {
      await client.query(
        "CREATE TEMP TABLE fishing_attempts_contract (LIKE fishing_attempts INCLUDING DEFAULTS INCLUDING CONSTRAINTS)",
      );

      for (const outcome of [
        { attemptNo: 1, roll: 18, rarity: "RARE", key: "rare-no-pool" },
        { attemptNo: 2, roll: 20, rarity: "EXTREMELY_RARE", key: "extreme-no-pool" },
      ] as const) {
        await expect(
          client.query(
            `INSERT INTO fishing_attempts_contract(
               id, player_id, content_release_id, area_id, fishing_day,
               attempt_no, idempotency_key, roll, rarity,
               fishing_point_name, encounter_table_slug
             ) VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, 'Rio dos Arrozais', NULL)`,
            [
              randomUUID(),
              randomUUID(),
              randomUUID(),
              randomUUID(),
              outcome.attemptNo,
              outcome.key,
              outcome.roll,
              outcome.rarity,
            ],
          ),
        ).resolves.toBeDefined();
      }

      const persisted = await client.query<{ roll: number; rarity: string; encounter_table_slug: string | null }>(
        `SELECT roll, rarity, encounter_table_slug
         FROM fishing_attempts_contract
         ORDER BY attempt_no`,
      );
      expect(persisted.rows).toEqual([
        { roll: 18, rarity: "RARE", encounter_table_slug: null },
        { roll: 20, rarity: "EXTREMELY_RARE", encounter_table_slug: null },
      ]);
    } finally {
      client.release();
    }
  });
});
