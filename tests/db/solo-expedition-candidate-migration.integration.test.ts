import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, runMigrations } from "../../src/platform/db/migrations.js";

const sourceUrl = process.env.DATABASE_URL ?? "";
const parsed = (() => {
  try {
    return new URL(sourceUrl);
  } catch {
    return null;
  }
})();

const isolated =
  parsed?.hostname === "127.0.0.1" &&
  parsed?.port === "5432" &&
  parsed?.pathname === "/postgres" &&
  process.env.APP_ENV === "test" &&
  process.env.NODE_ENV === "test" &&
  process.env.WHATSAPP_ENABLED === "false" &&
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1";

const suite = isolated ? describe.sequential : describe.skip;

suite("candidate 0080 schema reversible only in disposable PG18", () => {
  const dbName = "pokemon_cand_0080_" + randomUUID().replaceAll("-", "");
  let admin: Pool;
  let pool: Pool;
  let candidate = "";
  let draft = "";

  beforeAll(async () => {
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query('CREATE DATABASE "' + dbName + '"');
    const dbUrl = new URL(sourceUrl);
    dbUrl.pathname = "/" + dbName;
    pool = new Pool({ connectionString: dbUrl.toString(), max: 2 });
    await runMigrations(pool, { appliedBy: "disposable-candidate-0080-only" });
    [candidate, draft] = await Promise.all([
      readFile(
        new URL("../../db/candidates/0080_solo_exploration_v4.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../db/drafts/solo_exploration_v1_schema.sql", import.meta.url),
        "utf8",
      ),
    ]);
  }, 70_000);

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (admin !== undefined) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await admin.query('DROP DATABASE IF EXISTS "' + dbName + '"');
      await admin.end();
    }
  }, 30_000);

  it("keeps 0080 out of the active migrator and identical to staging", async () => {
    const migrations = await loadMigrations();
    expect(migrations.at(-1)?.versionText).toBe("0079");
    expect(migrations.some((entry) => entry.versionText === "0080")).toBe(false);
    expect(candidate).toContain("INTENTIONALLY NOT ACTIVE");
    expect(draft).toMatch(/^-- DRAFT ONLY: intentionally outside db\/migrations\./u);
    expect(candidate).not.toMatch(/INSERT\s+INTO\s+solo_/iu);
    const bodyMarker = "CREATE TABLE solo_expeditions";
    const candidateBody = candidate.slice(candidate.indexOf(bodyMarker));
    const draftBody = draft.slice(draft.indexOf(bodyMarker));
    expect(candidateBody).toBe(draftBody);
  });

  it("rolls back ten DDL relations and leaves migration ledger unchanged", async () => {
    const relations = [
      "solo_expeditions",
      "solo_expedition_receipts",
      "solo_expedition_search_outcomes",
      "solo_incidental_menu_snapshots",
      "solo_incidental_menu_deliveries",
      "solo_expedition_battle_receipts",
      "solo_search_outcome_policies",
      "solo_resource_loot_policies",
      "solo_expedition_resource_results",
      "solo_expedition_trail_follows",
    ];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(candidate);
      for (const table of relations) {
        const result = await client.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          ["public." + table],
        );
        expect(result.rows[0]?.present).toBe(table);
      }
      await client.query("ROLLBACK");
      for (const table of relations) {
        const result = await client.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          ["public." + table],
        );
        expect(result.rows[0]?.present).toBeNull();
      }
      const ledger = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM schema_migrations",
      );
      expect(ledger.rows[0]?.count).toBe("79");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);

  it("rolls back injected SQL error without half-applied V4 schema", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(candidate);
      await expect(client.query("SELECT 1/0")).rejects.toThrow();
      await client.query("ROLLBACK");
      const rows = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'solo_%'",
      );
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);
});
