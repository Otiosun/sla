import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PokemonCenterHealingService } from "../../src/modules/world-services/healing-service.js";
import { WorldServiceSessionService } from "../../src/modules/world-services/session-service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPokemonCenterHealingRepository } from "../../src/platform/world-services/postgres-pokemon-center-healing-repository.js";
import { PostgresWorldServiceSessionRepository } from "../../src/platform/world-services/postgres-world-service-session-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

interface ContentFixture {
  readonly rulesetId: string;
  readonly releaseId: string;
  readonly areaId: string;
  readonly formId: string;
  readonly moveId: string;
}

interface PlayerFixture {
  readonly playerId: PlayerId;
  readonly sessionId: string;
  readonly healInboxMessageId: string;
  readonly correlationId: string;
  readonly teamPokemonId: string;
  readonly boxPokemonId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seedPublishedContent(client: PoolClient): Promise<ContentFixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const moveId = randomUUID();
  const rulesetConfig = {
    schemaVersion: 1,
    battle: {
      statModel: "SIX_STATS",
      physicalSpecialByMove: true,
      ivEnabled: false,
      evEnabled: false,
      natureEnabled: false,
      maxMoves: 4,
      ppEnabled: true,
      criticalMultiplierBasisPoints: 15_000,
      accuracyEvasionEnabled: true,
    },
    capture: {
      model: "POKEMON_INSPIRED_V1",
      maxProbabilityBasisPoints: 9_500,
      allowedEncounterStates: ["IN_BATTLE"],
    },
    encounter: { expirationSeconds: 60 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
  } as const;

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `center-healing-${rulesetId}`, JSON.stringify(rulesetConfig)],
  );
  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "6".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );

  await client.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
    regionId,
    `center-healing-region-${regionId}`,
  ]);
  await client.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
    areaId,
    regionId,
    `center-healing-area-${areaId}`,
  ]);
  await client.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, $2)", [
    typeId,
    `center-healing-type-${typeId}`,
  ]);
  await client.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9801, $2)", [
    speciesId,
    `center-healing-species-${speciesId}`,
  ]);
  await client.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await client.query("INSERT INTO moves(id, slug) VALUES ($1, $2)", [
    moveId,
    `center-healing-move-${moveId}`,
  ]);
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 36001, 'Pokemon Center Healing Integration', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Center Testmon', $4, 40, 45, 40, 35, 35, 56)`,
    [randomUUID(), releaseId, formId, typeId],
  );
  await client.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, priority, max_pp
     ) VALUES ($1, $2, $3, 'Center Tackle', $4, 'PHYSICAL', 40, 100, 0, 35)`,
    [randomUUID(), releaseId, moveId, typeId],
  );
  await client.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "7".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { rulesetId, releaseId, areaId, formId, moveId };
}

async function insertInbox(
  client: PoolClient,
  playerId: PlayerId,
  correlationId = randomUUID(),
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO inbox_messages(
       id, provider, external_message_id, player_id, payload_hash, status, correlation_id
     ) VALUES ($1, 'baileys', $2, $3, $4, 'PROCESSED', $5)`,
    [id, `center-healing-${id}`, playerId, "c".repeat(64), correlationId],
  );
  return id;
}

async function seedPokemon(
  client: PoolClient,
  content: ContentFixture,
  playerId: PlayerId,
  placement: "TEAM" | "BOX",
  slotNo: number,
): Promise<string> {
  const pokemonId = randomUUID();
  await client.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, current_hp, origin_type
     ) VALUES ($1, $2, $3, 10, $4, 'TEST')`,
    [pokemonId, playerId, content.formId, placement === "TEAM" ? 4 : 3],
  );
  await client.query(
    `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
     VALUES ($1, 1, $2, $3)`,
    [pokemonId, content.moveId, placement === "TEAM" ? 2 : 1],
  );
  await client.query(
    `INSERT INTO pokemon_roster_slots(
       pokemon_instance_id, player_id, placement_kind, box_no, slot_no
     ) VALUES ($1, $2, $3, $4, $5)`,
    [pokemonId, playerId, placement, placement === "TEAM" ? null : 1, slotNo],
  );
  await client.query(
    `INSERT INTO pokemon_persistent_conditions(
       pokemon_instance_id, condition_key, source_type, source_id, data
     ) VALUES ($1, $2, 'TEST', $3, '{}'::jsonb)`,
    [pokemonId, placement === "TEAM" ? "POISON" : "BURN", randomUUID()],
  );
  if (placement === "TEAM") {
    await client.query(
      `INSERT INTO pokemon_persistent_conditions(
         pokemon_instance_id, condition_key, source_type, source_id, data
       ) VALUES ($1, 'CURSE', 'TEST', $2, '{}'::jsonb)`,
      [pokemonId, randomUUID()],
    );
  }
  return pokemonId;
}

async function seedPlayer(pool: Pool, content: ContentFixture): Promise<PlayerFixture> {
  const client = await pool.connect();
  try {
    const playerId = createPlayerId();
    await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    const sceneInboxMessageId = await insertInbox(client, playerId);
    const correlationId = randomUUID();
    const healInboxMessageId = await insertInbox(client, playerId, correlationId);
    const teamPokemonId = await seedPokemon(client, content, playerId, "TEAM", 1);
    const boxPokemonId = await seedPokemon(client, content, playerId, "BOX", 1);

    const sessions = new WorldServiceSessionService(
      new PostgresWorldServiceSessionRepository(pool),
      new ManualClock(new Date("2026-09-07T12:00:00.000Z")),
    );
    const proof = await sessions.recordSceneProof({
      playerId,
      areaId: content.areaId,
      sourceInboxMessageId: sceneInboxMessageId,
      text: "cheguei ao centro\natravessei a porta\nfui até o balcão\nfalei com Hana",
    });
    if (!proof.ok) throw new Error(`${proof.error.code}: ${proof.error.message}`);
    const opened = await sessions.openVisit({
      playerId,
      areaId: content.areaId,
      serviceKind: "POKEMON_CENTER",
    });
    if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);

    return {
      playerId,
      sessionId: opened.value.sessionId,
      healInboxMessageId,
      correlationId,
      teamPokemonId,
      boxPokemonId,
    };
  } finally {
    client.release();
  }
}

function healingInput(player: PlayerFixture) {
  return {
    playerId: player.playerId,
    sessionId: player.sessionId,
    sourceInboxMessageId: player.healInboxMessageId,
    correlationId: player.correlationId,
  } as const;
}

describe.sequential("Pokemon Center healing PostgreSQL integration", () => {
  const dbName = `pokemon_center_healing_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let content: ContentFixture;
  let service: PokemonCenterHealingService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "pokemon-center-healing-vitest" });
    const client = await pool.connect();
    try {
      content = await seedPublishedContent(client);
    } finally {
      client.release();
    }
    service = new PokemonCenterHealingService(new PostgresPokemonCenterHealingRepository(pool));
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

  it("creates a durable idempotency claim table", async () => {
    const table = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.pokemon_center_healing_claims')::text AS name",
    );
    expect(table.rows[0]?.name).toBe("pokemon_center_healing_claims");
  });

  it("restores TEAM HP/PP/major status, preserves other conditions, leaves BOX untouched and replays once", async () => {
    const player = await seedPlayer(pool, content);

    const first = await service.healTeam(healingInput(player));
    expect(first).toEqual({
      ok: true,
      value: {
        healedPokemonCount: 1,
        hpRestoredPokemonCount: 1,
        ppRestoredSlots: 1,
        statusesCleared: 1,
        replayed: false,
      },
    });

    const pokemon = await pool.query<{ id: string; current_hp: number; revision: string }>(
      `SELECT id, current_hp, revision::text
       FROM pokemon_instances
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[player.teamPokemonId, player.boxPokemonId]],
    );
    const team = pokemon.rows.find((row) => row.id === player.teamPokemonId);
    const box = pokemon.rows.find((row) => row.id === player.boxPokemonId);
    expect(team).toMatchObject({ current_hp: 28, revision: "1" });
    expect(box).toMatchObject({ current_hp: 3, revision: "0" });

    const moves = await pool.query<{ pokemon_instance_id: string; pp_current: number | null }>(
      `SELECT pokemon_instance_id, pp_current
       FROM pokemon_move_slots
       WHERE pokemon_instance_id = ANY($1::uuid[])
       ORDER BY pokemon_instance_id`,
      [[player.teamPokemonId, player.boxPokemonId]],
    );
    expect(
      moves.rows.find((row) => row.pokemon_instance_id === player.teamPokemonId)?.pp_current,
    ).toBe(35);
    expect(
      moves.rows.find((row) => row.pokemon_instance_id === player.boxPokemonId)?.pp_current,
    ).toBe(1);

    const conditions = await pool.query<{ pokemon_instance_id: string; condition_key: string }>(
      `SELECT pokemon_instance_id, condition_key
       FROM pokemon_persistent_conditions
       WHERE pokemon_instance_id = ANY($1::uuid[])
       ORDER BY pokemon_instance_id, condition_key`,
      [[player.teamPokemonId, player.boxPokemonId]],
    );
    expect(conditions.rows).toEqual(
      [
        { pokemon_instance_id: player.teamPokemonId, condition_key: "CURSE" },
        { pokemon_instance_id: player.boxPokemonId, condition_key: "BURN" },
      ].sort((left, right) =>
        `${left.pokemon_instance_id}:${left.condition_key}`.localeCompare(
          `${right.pokemon_instance_id}:${right.condition_key}`,
        ),
      ),
    );

    const historyBeforeReplay = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pokemon_history_events
       WHERE pokemon_instance_id = $1 AND event_type = 'POKEMON_CENTER_HEALED'`,
      [player.teamPokemonId],
    );
    expect(historyBeforeReplay.rows[0]?.count).toBe("1");

    const replay = await service.healTeam(healingInput(player));
    expect(replay).toEqual({
      ok: true,
      value: {
        healedPokemonCount: 1,
        hpRestoredPokemonCount: 1,
        ppRestoredSlots: 1,
        statusesCleared: 1,
        replayed: true,
      },
    });
    const evidence = await pool.query<{ claims: string; history: string; revision: string }>(
      `SELECT
         (SELECT count(*)::text FROM pokemon_center_healing_claims
          WHERE source_inbox_message_id = $1) AS claims,
         (SELECT count(*)::text FROM pokemon_history_events
          WHERE pokemon_instance_id = $2 AND event_type = 'POKEMON_CENTER_HEALED') AS history,
         (SELECT revision::text FROM pokemon_instances WHERE id = $2) AS revision`,
      [player.healInboxMessageId, player.teamPokemonId],
    );
    expect(evidence.rows[0]).toEqual({ claims: "1", history: "1", revision: "1" });
  });

  it("rejects healing during an active battle before mutating or claiming", async () => {
    const player = await seedPlayer(pool, content);
    const battleId = randomUUID();
    const sideId = randomUUID();
    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id,
         turn_number, version, rng_seed_ciphertext, rng_seed_iv,
         rng_seed_auth_tag, rng_seed_key_version, rng_counter
       ) VALUES ($1, 'PVP', 'ACTIVE', $2, $3, 1, 0, $4, $5, $6, 1, 0)`,
      [
        battleId,
        content.releaseId,
        content.rulesetId,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(16, 3),
      ],
    );
    await pool.query(
      `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
       VALUES ($1, $2, 1, 'PLAYER', $3)`,
      [sideId, battleId, player.playerId],
    );

    const result = await service.healTeam(healingInput(player));
    expect(result).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    const state = await pool.query<{ hp: number; claims: string }>(
      `SELECT
         (SELECT current_hp FROM pokemon_instances WHERE id = $1) AS hp,
         (SELECT count(*)::text FROM pokemon_center_healing_claims
          WHERE source_inbox_message_id = $2) AS claims`,
      [player.teamPokemonId, player.healInboxMessageId],
    );
    expect(state.rows[0]).toEqual({ hp: 4, claims: "0" });
  });
});
