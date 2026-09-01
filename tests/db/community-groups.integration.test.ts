import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("community group schema on disposable PostgreSQL", () => {
  const dbName = `pokemon_community_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "community-schema-vitest" });
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

  it("creates the group, capability, staff and member-presence relations", async () => {
    const result = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('public.' || relation_name)::text AS relation
       FROM unnest(ARRAY[
         'community_groups',
         'community_group_capabilities',
         'reception_staff_assignments',
         'community_member_presence'
       ]) AS names(relation_name)
       ORDER BY relation_name`,
    );

    expect(result.rows.map((row) => row.relation)).toEqual([
      "community_group_capabilities",
      "community_groups",
      "community_member_presence",
      "reception_staff_assignments",
    ]);
  });
});
