import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import {
  recordPokedexCaught,
  recordPokedexOwned,
  recordPokedexSeen,
} from "../../src/platform/pokedex/postgres-pokedex-writer.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("Pokédex PostgreSQL writer semantics", () => {
  const dbName = `pokemon_pokedex_writer_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let playerId: string;
  let speciesId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 2 });
    await runMigrations(pool, { appliedBy: "pokedex-writer-proof" });
    playerId = randomUUID();
    speciesId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9999, $2)",
      [speciesId, `proof-${speciesId}`],
    );
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

  it("counts observations/captures but ownership-only events do not inflate existing counts", async () => {
    const client = await pool.connect();
    try {
      await recordPokedexSeen(client, playerId, speciesId);
      await recordPokedexSeen(client, playerId, speciesId);
      await recordPokedexCaught(client, playerId, speciesId);
      await recordPokedexCaught(client, playerId, speciesId);

      const beforeOwned = await pool.query<{
        seen_count: string;
        caught_count: string;
        first_seen_at: Date | null;
        last_seen_at: Date | null;
        first_caught_at: Date | null;
        last_caught_at: Date | null;
      }>(
        `SELECT seen_count::text, caught_count::text,
                first_seen_at, last_seen_at, first_caught_at, last_caught_at
         FROM player_pokedex_species
         WHERE player_id = $1 AND species_id = $2`,
        [playerId, speciesId],
      );
      expect(beforeOwned.rows[0]).toMatchObject({ seen_count: "4", caught_count: "2" });

      await recordPokedexOwned(client, playerId, speciesId);
      const afterOwned = await pool.query<{
        seen_count: string;
        caught_count: string;
        first_seen_at: Date | null;
        last_seen_at: Date | null;
        first_caught_at: Date | null;
        last_caught_at: Date | null;
      }>(
        `SELECT seen_count::text, caught_count::text,
                first_seen_at, last_seen_at, first_caught_at, last_caught_at
         FROM player_pokedex_species
         WHERE player_id = $1 AND species_id = $2`,
        [playerId, speciesId],
      );
      expect(afterOwned.rows[0]).toEqual(beforeOwned.rows[0]);
      expect(afterOwned.rows[0]?.first_seen_at).toBeInstanceOf(Date);
      expect(afterOwned.rows[0]?.last_seen_at).toBeInstanceOf(Date);
      expect(afterOwned.rows[0]?.first_caught_at).toBeInstanceOf(Date);
      expect(afterOwned.rows[0]?.last_caught_at).toBeInstanceOf(Date);
    } finally {
      client.release();
    }
  }, 30_000);
});
