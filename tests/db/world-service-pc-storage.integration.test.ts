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
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("Pokemon PC PostgreSQL storage", () => {
  const dbName = `pokemon_pc_storage_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresPokemonPcStorageRepository;
  let playerId: PlayerId;
  let rulesetId = "";
  let releaseId = "";
  let speciesId = "";
  let formId = "";

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "pc-storage-vitest" });
    repository = new PostgresPokemonPcStorageRepository(pool);

    playerId = createPlayerId();
    rulesetId = randomUUID();
    releaseId = randomUUID();
    speciesId = randomUUID();
    formId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(
         id, key, version, engine_contract_version, config, status, published_at
       ) VALUES ($1, 'pc-storage-proof', 1, 1, '{}'::jsonb, 'PUBLISHED', now())`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(
         id, release_no, name, status, default_ruleset_id, published_at
       ) VALUES ($1, 999991, 'PC Storage Proof', 'PUBLISHED', $2, now())`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9998, 'eevee')", [
      speciesId,
    ]);
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_species_revisions(
         id, content_release_id, species_id, display_name, active
       ) VALUES ($1, $2, $3, 'Eevee', TRUE)`,
      [randomUUID(), releaseId, speciesId],
    );
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO player_onboarding_context(player_id, content_release_id, ruleset_id)
       VALUES ($1, $2, $3)`,
      [playerId, releaseId, rulesetId],
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

  async function clearRoster(): Promise<void> {
    await pool.query("DELETE FROM pokemon_roster_slots WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM pokemon_instances WHERE owner_player_id = $1", [playerId]);
  }

  it("loads deterministic team and box contents using the player pinned content release", async () => {
    await clearRoster();
    const teamPokemon = await pokemon("TEAM", 1);
    const boxedPokemon = await pokemon("BOX", 1, 1);

    const snapshot = await repository.loadStorage(playerId);

    expect(snapshot.team).toEqual([
      expect.objectContaining({
        pokemonInstanceId: teamPokemon,
        displayName: "Eevee",
        level: 8,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      }),
    ]);
    expect(snapshot.boxes).toEqual([
      {
        boxNo: 1,
        occupied: 1,
        capacity: 30,
        pokemon: [
          expect.objectContaining({
            pokemonInstanceId: boxedPokemon,
            displayName: "Eevee",
            placementKind: "BOX",
            boxNo: 1,
            slotNo: 1,
          }),
        ],
      },
    ]);
  });

  it("deposits a team Pokemon into the first free box slot atomically", async () => {
    await clearRoster();
    await pokemon("TEAM", 1);
    const depositedPokemon = await pokemon("TEAM", 2);
    await pokemon("BOX", 1, 1);

    const result = await repository.deposit({ playerId, pokemonInstanceId: depositedPokemon });

    expect(result).toEqual({
      kind: "APPLIED",
      pokemonInstanceId: depositedPokemon,
      fromSlotNo: 2,
      boxNo: 1,
      slotNo: 2,
    });
    const row = await pool.query(
      `SELECT placement_kind, box_no, slot_no
       FROM pokemon_roster_slots WHERE pokemon_instance_id = $1`,
      [depositedPokemon],
    );
    expect(row.rows[0]).toEqual({ placement_kind: "BOX", box_no: 1, slot_no: 2 });
  });

  it("refuses to deposit the last Pokemon in the active team", async () => {
    await clearRoster();
    const onlyPokemon = await pokemon("TEAM", 1);

    const result = await repository.deposit({ playerId, pokemonInstanceId: onlyPokemon });

    expect(result).toEqual({ kind: "LAST_TEAM_MEMBER" });
    const row = await pool.query(
      "SELECT placement_kind, slot_no FROM pokemon_roster_slots WHERE pokemon_instance_id = $1",
      [onlyPokemon],
    );
    expect(row.rows[0]).toEqual({ placement_kind: "TEAM", slot_no: 1 });
  });

  it("withdraws a boxed Pokemon into the first free team slot", async () => {
    await clearRoster();
    await pokemon("TEAM", 1);
    await pokemon("TEAM", 3);
    const boxedPokemon = await pokemon("BOX", 4, 2);

    const result = await repository.withdraw({ playerId, pokemonInstanceId: boxedPokemon });

    expect(result).toEqual({
      kind: "APPLIED",
      pokemonInstanceId: boxedPokemon,
      fromBoxNo: 2,
      fromSlotNo: 4,
      teamSlotNo: 2,
    });
    const row = await pool.query(
      `SELECT placement_kind, box_no, slot_no
       FROM pokemon_roster_slots WHERE pokemon_instance_id = $1`,
      [boxedPokemon],
    );
    expect(row.rows[0]).toEqual({ placement_kind: "TEAM", box_no: null, slot_no: 2 });
  });

  it("refuses withdrawal when all six team slots are occupied", async () => {
    await clearRoster();
    for (let slot = 1; slot <= 6; slot += 1) await pokemon("TEAM", slot);
    const boxedPokemon = await pokemon("BOX", 1, 1);

    const result = await repository.withdraw({ playerId, pokemonInstanceId: boxedPokemon });

    expect(result).toEqual({ kind: "TEAM_FULL" });
    const row = await pool.query(
      `SELECT placement_kind, box_no, slot_no
       FROM pokemon_roster_slots WHERE pokemon_instance_id = $1`,
      [boxedPokemon],
    );
    expect(row.rows[0]).toEqual({ placement_kind: "BOX", box_no: 1, slot_no: 1 });
  });

  it("organizes a boxed Pokemon into a free box and slot", async () => {
    await clearRoster();
    const boxedPokemon = await pokemon("BOX", 1, 1);

    const result = await repository.organize({
      playerId,
      pokemonInstanceId: boxedPokemon,
      boxNo: 3,
      slotNo: 12,
    });

    expect(result).toEqual({
      kind: "APPLIED",
      pokemonInstanceId: boxedPokemon,
      fromBoxNo: 1,
      fromSlotNo: 1,
      toBoxNo: 3,
      toSlotNo: 12,
    });
  });

  it("does not overwrite an occupied destination while organizing", async () => {
    await clearRoster();
    const source = await pokemon("BOX", 1, 1);
    const destination = await pokemon("BOX", 12, 3);

    const result = await repository.organize({
      playerId,
      pokemonInstanceId: source,
      boxNo: 3,
      slotNo: 12,
    });

    expect(result).toEqual({ kind: "DESTINATION_OCCUPIED" });
    const rows = await pool.query(
      `SELECT pokemon_instance_id, box_no, slot_no
       FROM pokemon_roster_slots
       WHERE pokemon_instance_id = ANY($1::uuid[])
       ORDER BY pokemon_instance_id`,
      [[source, destination]],
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { pokemon_instance_id: source, box_no: 1, slot_no: 1 },
        { pokemon_instance_id: destination, box_no: 3, slot_no: 12 },
      ]),
    );
  });
});
