import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

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

describe.sequential("Player Portal owned Pokemon on disposable PostgreSQL", () => {
  const dbName = `pokemon_portal_owned_${process.pid}_${Date.now()}`;
  const playerId = createPlayerId();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const teamPokemonId = createPokemonInstanceId();
  const boxPokemonId = createPokemonInstanceId();
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "player-portal-owned-vitest" });

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 4, 'charmander')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, nickname, level, current_hp, gender, shiny, origin_type
       ) VALUES
         ($1, $3, $4, 'Brasa', 12, 31, 'M', FALSE, 'STARTER'),
         ($2, $3, $4, NULL, 8, 19, 'F', TRUE, 'CAPTURE')`,
      [teamPokemonId, boxPokemonId, playerId, formId],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES
         ($1, $3, 'TEAM', NULL, 2),
         ($2, $3, 'BOX', 1, 1)`,
      [teamPokemonId, boxPokemonId, playerId],
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

  it("reads only active owned instances with their authoritative roster placement", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const owned = await repository.read((transaction) => transaction.listOwnedPokemon(playerId));

    expect(owned).toEqual([
      {
        pokemonInstanceId: teamPokemonId,
        formId,
        nickname: "Brasa",
        level: 12,
        currentHp: 31,
        gender: "M",
        shiny: false,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 2,
      },
      {
        pokemonInstanceId: boxPokemonId,
        formId,
        nickname: null,
        level: 8,
        currentHp: 19,
        gender: "F",
        shiny: true,
        placementKind: "BOX",
        boxNo: 1,
        slotNo: 1,
      },
    ]);
  });

  it("atomically swaps Team and Box placements without violating unique roster slots", async () => {
    const repository = new PostgresPlayerOnboardingRepository(pool);
    const moved = await repository.transaction((transaction) =>
      transaction.moveOwnedPokemon({
        playerId,
        pokemonInstanceId: boxPokemonId,
        target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
      }),
    );

    expect(moved).toBe(true);

    const owned = await repository.read((transaction) => transaction.listOwnedPokemon(playerId));
    const movedToTeam = owned.find((pokemon) => pokemon.pokemonInstanceId === boxPokemonId);
    const movedToBox = owned.find((pokemon) => pokemon.pokemonInstanceId === teamPokemonId);

    expect(movedToTeam).toMatchObject({
      placementKind: "TEAM",
      boxNo: null,
      slotNo: 2,
    });
    expect(movedToBox).toMatchObject({
      placementKind: "BOX",
      boxNo: 1,
      slotNo: 1,
    });
  });
});
