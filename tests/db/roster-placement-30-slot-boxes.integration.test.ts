import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCaptureRepository } from "../../src/platform/capture/postgres-capture-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { parsePlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

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

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Fixture PlayerId is invalid");
  return parsed.value;
}

describe.sequential("canonical 30-slot roster placement", () => {
  const dbName = `pokemon_roster_30_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let owner: PlayerId;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "roster-30-slot-vitest" });

    const ownerRaw = randomUUID();
    const speciesId = randomUUID();
    const formId = randomUUID();
    owner = playerId(ownerRaw);

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [ownerRaw]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9999, 'roster-proof')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
      formId,
      speciesId,
    ]);

    for (let slot = 1; slot <= 6; slot += 1) {
      const pokemonId = randomUUID();
      await pool.query(
        `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
         VALUES ($1, $2, $3, 5, 20, 'TEST')`,
        [pokemonId, ownerRaw, formId],
      );
      await pool.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, 'TEAM', NULL, $3)`,
        [pokemonId, ownerRaw, slot],
      );
    }

    for (let slot = 1; slot <= 30; slot += 1) {
      const pokemonId = randomUUID();
      await pool.query(
        `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
         VALUES ($1, $2, $3, 5, 20, 'TEST')`,
        [pokemonId, ownerRaw, formId],
      );
      await pool.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, box_no, slot_no
         ) VALUES ($1, $2, 'BOX', 1, $3)`,
        [pokemonId, ownerRaw, slot],
      );
    }
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

  it("rolls starter placement from full Box 1 to Box 2 slot 1", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const placement = await repository.transaction((tx) => tx.nextRosterPlacement(owner));

    expect(placement).toEqual({ placementKind: "BOX", boxNo: 2, slotNo: 1 });
  });

  it("rolls capture placement from full Box 1 to Box 2 slot 1", async () => {
    const repository = new PostgresCaptureRepository(pool);
    const placement = await repository.transaction((tx) => tx.nextRosterPlacement(owner));

    expect(placement).toEqual({ placementKind: "BOX", boxNo: 2, slotNo: 1 });
  });
});
