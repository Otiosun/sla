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

describe.sequential("Fishing PostgreSQL schema", () => {
  const dbName = `pokemon_fishing_schema_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 2 });
    await runMigrations(pool, { appliedBy: "fishing-schema-vitest" });
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

  it("creates the durable fishing_attempts authority with the required snapshot columns", async () => {
    const table = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('public.fishing_attempts')::text AS relation",
    );
    expect(table.rows[0]?.relation).toBe("fishing_attempts");

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fishing_attempts'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "id",
        "player_id",
        "content_release_id",
        "area_id",
        "fishing_day",
        "attempt_no",
        "idempotency_key",
        "roll",
        "rarity",
        "fishing_point_name",
        "encounter_table_slug",
        "created_at",
      ]),
    );
  });
});
