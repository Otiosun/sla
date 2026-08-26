import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, runMigrations } from "../../src/platform/db/migrations.js";

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

describe.sequential("migration history ordering beyond version 0009", () => {
  const dbName = `pokemon_migration_order_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 2 });
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

  it("re-verifies 10+ applied migrations in numeric rather than lexical order", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(10);

    const first = await runMigrations(pool, { appliedBy: "migration-order-proof-first" });
    expect(first).toHaveLength(migrations.length);

    const second = await runMigrations(pool, { appliedBy: "migration-order-proof-replay" });
    expect(second).toHaveLength(migrations.length);

    const versions = await pool.query<{ version: string }>(
      "SELECT version::text AS version FROM schema_migrations ORDER BY schema_migrations.version ASC",
    );
    expect(versions.rows.map((row) => row.version)).toEqual(
      migrations.map((migration) => migration.version.toString()),
    );
  }, 30_000);
});
