import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPokemonPcStorageRepository } from "../../src/platform/world-services/postgres-pokemon-pc-storage-repository.js";
import {
  createPlayerId,
  createPokemonInstanceId,
  type PlayerId,
  type PokemonInstanceId,
} from "../../src/shared-kernel/ids.js";

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

describe.sequential("Hub roster movement through canonical Pokemon PC storage owner", () => {
  const dbName = `pokemon_hub_pc_move_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresPokemonPcStorageRepository;
  let playerId: PlayerId;
  let formId = "";

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "hub-pc-move-vitest" });
    repository = new PostgresPokemonPcStorageRepository(pool);

    playerId = createPlayerId();
    const speciesId = randomUUID();
    formId = randomUUID();

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9997, 'hub-proof')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
      formId,
      speciesId,
    ]);
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

  async function clearRoster(): Promise<void> {
    await pool.query("DELETE FROM pokemon_roster_slots WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM pokemon_instances WHERE owner_player_id = $1", [playerId]);
  }

  async function pokemon(
    placementKind: "TEAM" | "BOX",
    slotNo: number,
    boxNo: number | null = null,
  ): Promise<PokemonInstanceId> {
    const pokemonInstanceId = createPokemonInstanceId();
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, origin_type
       ) VALUES ($1, $2, $3, 8, 24, 'TEST')`,
      [pokemonInstanceId, playerId, formId],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, $3, $4, $5)`,
      [pokemonInstanceId, playerId, placementKind, boxNo, slotNo],
    );
    return pokemonInstanceId;
  }

  it("atomically swaps a team Pokemon with an occupied box destination", async () => {
    await clearRoster();
    await pokemon("TEAM", 1);
    const teamPokemon = await pokemon("TEAM", 2);
    const boxedPokemon = await pokemon("BOX", 1, 1);

    const result = await repository.move({
      playerId,
      pokemonInstanceId: teamPokemon,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
    });

    expect(result).toMatchObject({
      kind: "APPLIED",
      pokemonInstanceId: teamPokemon,
      fromPlacementKind: "TEAM",
      fromSlotNo: 2,
      toPlacementKind: "BOX",
      toBoxNo: 1,
      toSlotNo: 1,
      swappedPokemonInstanceId: boxedPokemon,
    });

    const rows = await pool.query<{
      pokemon_instance_id: string;
      placement_kind: string;
      box_no: number | null;
      slot_no: number;
    }>(
      `SELECT pokemon_instance_id::text, placement_kind, box_no, slot_no
       FROM pokemon_roster_slots
       WHERE pokemon_instance_id = ANY($1::uuid[])
       ORDER BY pokemon_instance_id`,
      [[teamPokemon, boxedPokemon]],
    );

    expect(rows.rows).toEqual(
      expect.arrayContaining([
        {
          pokemon_instance_id: teamPokemon,
          placement_kind: "BOX",
          box_no: 1,
          slot_no: 1,
        },
        {
          pokemon_instance_id: boxedPokemon,
          placement_kind: "TEAM",
          box_no: null,
          slot_no: 2,
        },
      ]),
    );
  });

  it("refuses moving the sole team member into an empty box slot", async () => {
    await clearRoster();
    const onlyPokemon = await pokemon("TEAM", 1);

    expect(
      await repository.move({
        playerId,
        pokemonInstanceId: onlyPokemon,
        target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
      }),
    ).toEqual({ kind: "LAST_TEAM_MEMBER" });

    const row = await pool.query(
      "SELECT placement_kind, box_no, slot_no FROM pokemon_roster_slots WHERE pokemon_instance_id = $1",
      [onlyPokemon],
    );
    expect(row.rows[0]).toEqual({ placement_kind: "TEAM", box_no: null, slot_no: 1 });
  });

  it("swaps a boxed Pokemon into an occupied team slot without creating a seventh member", async () => {
    await clearRoster();
    const teamPokemon = await pokemon("TEAM", 1);
    const boxedPokemon = await pokemon("BOX", 3, 2);

    const result = await repository.move({
      playerId,
      pokemonInstanceId: boxedPokemon,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 1 },
    });

    expect(result).toMatchObject({
      kind: "APPLIED",
      swappedPokemonInstanceId: teamPokemon,
      toPlacementKind: "TEAM",
      toSlotNo: 1,
    });

    const teamCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pokemon_roster_slots WHERE player_id = $1 AND placement_kind = 'TEAM'",
      [playerId],
    );
    expect(teamCount.rows[0]?.count).toBe("1");
  });
});
