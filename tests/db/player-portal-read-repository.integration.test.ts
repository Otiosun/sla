import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerPortalReadRepository } from "../../src/platform/player-portal/postgres-player-portal-read-repository.js";
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

describe.sequential("Player Portal read projection on disposable PostgreSQL", () => {
  const dbName = `pokemon_hub_read_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  const playerId = createPlayerId();
  const pokemonInstanceId = createPokemonInstanceId();
  const releaseId = randomUUID();

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "hub-read-vitest" });

    const rulesetId = randomUUID();
    const typeId = randomUUID();
    const speciesId = randomUUID();
    const formId = randomUUID();
    const moveId = randomUUID();
    const itemId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, 'hub-read-proof', 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 999992, 'Hub Read Proof', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'grass')", [typeId]);
    await pool.query(
      `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name, active)
       VALUES ($1, $2, $3, 'Grass', TRUE)`,
      [randomUUID(), releaseId, typeId],
    );
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 152, 'chikorita')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'chikorita')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_species_revisions(
         id, content_release_id, species_id, display_name, active
       ) VALUES ($1, $2, $3, 'Chikorita', TRUE)`,
      [randomUUID(), releaseId, speciesId],
    );
    await pool.query(
      `INSERT INTO pokemon_form_revisions(
         id, content_release_id, form_id, display_name, type1_id,
         base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed, active
       ) VALUES ($1, $2, $3, 'Chikorita', $4, 45, 49, 65, 49, 65, 45, TRUE)`,
      [randomUUID(), releaseId, formId, typeId],
    );

    await pool.query("INSERT INTO moves(id, slug) VALUES ($1, 'tackle')", [moveId]);
    await pool.query(
      `INSERT INTO move_revisions(
         id, content_release_id, move_id, display_name, type_id, category,
         power, accuracy, priority, max_pp, active
       ) VALUES ($1, $2, $3, 'Tackle', $4, 'PHYSICAL', 40, 100, 0, 35, TRUE)`,
      [randomUUID(), releaseId, moveId, typeId],
    );

    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'potion')", [itemId]);
    await pool.query(
      `INSERT INTO item_revisions(
         id, content_release_id, item_id, display_name, item_kind, active
       ) VALUES ($1, $2, $3, 'Potion', 'CONSUMABLE', TRUE)`,
      [randomUUID(), releaseId, itemId],
    );

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, nickname, level, current_hp, gender, shiny, origin_type
       ) VALUES ($1, $2, $3, 'Folha', 5, 20, 'F', FALSE, 'STARTER')`,
      [pokemonInstanceId, playerId, formId],
    );
    await pool.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, iv_hp, ev_hp
       ) VALUES ($1, 31, 0)`,
      [pokemonInstanceId],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, 'TEAM', NULL, 1)`,
      [pokemonInstanceId, playerId],
    );
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, 1, $2, 34)`,
      [pokemonInstanceId, moveId],
    );
    await pool.query(
      `INSERT INTO pokemon_persistent_conditions(
         pokemon_instance_id, condition_key, source_type, source_id
       ) VALUES ($1, 'POISON', 'TEST', 'hub-read')`,
      [pokemonInstanceId],
    );
    await pool.query(
      `INSERT INTO player_pokedex_species(
         player_id, species_id, seen_count, caught_count, first_seen_at, last_seen_at,
         first_caught_at, last_caught_at
       ) VALUES ($1, $2, 2, 1, now(), now(), now(), now())`,
      [playerId, speciesId],
    );
    await pool.query(
      "INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, 3)",
      [playerId, itemId],
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

  it("projects owned Pokemon with HP, PP, status and authoritative presentation", async () => {
    const repository = new PostgresPlayerPortalReadRepository(pool);
    const pokemon = await repository.listOwnedPokemon(playerId, releaseId);

    expect(pokemon).toEqual([
      expect.objectContaining({
        pokemonInstanceId,
        formSlug: "chikorita",
        speciesSlug: "chikorita",
        displayName: "Chikorita",
        nationalDex: 152,
        typeNames: ["Grass"],
        nickname: "Folha",
        level: 5,
        currentHp: 20,
        maxHp: 21,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
        conditions: ["POISON"],
        moves: [
          {
            slotNo: 1,
            moveId: expect.any(String),
            displayName: "Tackle",
            typeName: "Grass",
            category: "PHYSICAL",
            power: 40,
            accuracy: 100,
            ppCurrent: 34,
            maxPp: 35,
          },
        ],
      }),
    ]);
  });

  it("projects authoritative Pokedex and inventory reads", async () => {
    const repository = new PostgresPlayerPortalReadRepository(pool);
    const [pokedex, inventory] = await Promise.all([
      repository.listPokedex(playerId, releaseId),
      repository.listInventory(playerId, releaseId),
    ]);

    expect(pokedex).toEqual([
      expect.objectContaining({
        nationalDex: 152,
        speciesSlug: "chikorita",
        displayName: "Chikorita",
        seenCount: "2",
        caughtCount: "1",
      }),
    ]);
    expect(inventory).toEqual([
      expect.objectContaining({
        itemSlug: "potion",
        displayName: "Potion",
        quantity: "3",
      }),
    ]);
  });
});
