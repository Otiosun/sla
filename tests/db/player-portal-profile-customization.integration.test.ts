import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerPortalProfileCustomizationRepository } from "../../src/platform/player-portal/postgres-player-portal-profile-customization-repository.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

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

describe.sequential("Hub profile customization on disposable PostgreSQL", () => {
  const dbName = `pokemon_hub_profile_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  const playerId = createPlayerId();

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 2 });
    await runMigrations(pool, { appliedBy: "hub-profile-vitest" });

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO player_profiles(player_id, trainer_name, locale, metadata)
       VALUES ($1, 'Natan', 'pt-BR', '{"legacy":{"keep":true}}'::jsonb)`,
      [playerId],
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

  it("stores Hub customization without replacing unrelated profile metadata", async () => {
    const repository = new PostgresPlayerPortalProfileCustomizationRepository(pool);

    await expect(repository.read(playerId)).resolves.toEqual({
      title: null,
      bio: null,
      appearance: null,
      age: null,
      height: null,
      accent: "teal",
    });

    const customization = {
      title: "Explorador",
      bio: "Sempre seguindo a próxima trilha.",
      appearance: "Casaco escuro e mochila de campo.",
      age: 29,
      height: "1,94 m",
      accent: "gold" as const,
    };

    await expect(repository.update(playerId, customization)).resolves.toBe(true);
    await expect(repository.read(playerId)).resolves.toEqual(customization);

    const stored = await pool.query<{ metadata: Record<string, unknown>; revision: string }>(
      `SELECT metadata, revision::text
       FROM player_profiles
       WHERE player_id = $1`,
      [playerId],
    );

    expect(stored.rows[0]?.metadata).toMatchObject({
      legacy: { keep: true },
      hubCustomization: customization,
    });
    expect(stored.rows[0]?.revision).toBe("1");
  });
});
