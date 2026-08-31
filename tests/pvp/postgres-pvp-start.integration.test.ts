import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EncounterSeedProvider, SeedMaterial } from "../../src/modules/encounter/ports.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPvpStartRepository } from "../../src/platform/pvp/postgres-pvp-start-repository.js";

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

class CountingSeedProvider implements EncounterSeedProvider {
  public calls = 0;

  public create(): SeedMaterial {
    this.calls += 1;
    const seed = new Uint8Array(32).fill(this.calls);
    return {
      seed,
      envelope: {
        ciphertext: seed,
        iv: new Uint8Array(12).fill(2),
        authTag: new Uint8Array(16).fill(3),
        keyVersion: 1,
      },
    };
  }
}

interface CatalogFixture {
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly formId: string;
  readonly abilityId: string;
  readonly natureId: string;
  readonly moveId: string;
}

interface AcceptedMatchFixture {
  readonly challengeId: string;
  readonly encounterId: string;
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly eligiblePokemonIds: readonly string[];
}

async function seedCatalog(pool: Pool): Promise<CatalogFixture> {
  const regionId = randomUUID();
  const areaId = randomUUID();
  const rulesetId = randomUUID();
  const contentReleaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const moveId = randomUUID();
  const publishedAt = new Date("2026-08-31T12:00:00.000Z");

  await pool.query(
    `INSERT INTO rulesets(
       id, key, version, engine_contract_version, config, status
     ) VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `pvp-start-ruleset-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, default_ruleset_id
     ) VALUES ($1, 28002, 'PVP start integration', 'DRAFT', $2)`,
    [contentReleaseId, rulesetId],
  );
  await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
    regionId,
    `pvp-start-region-${regionId}`,
  ]);
  await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
    areaId,
    regionId,
    `pvp-start-area-${areaId}`,
  ]);
  await pool.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'normal')", [typeId]);
  await pool.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 900, $2)", [
    speciesId,
    `pvp-start-species-${speciesId}`,
  ]);
  await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await pool.query("INSERT INTO abilities(id, slug) VALUES ($1, $2)", [
    abilityId,
    `pvp-start-ability-${abilityId}`,
  ]);
  await pool.query("INSERT INTO natures(id, slug) VALUES ($1, $2)", [
    natureId,
    `pvp-start-nature-${natureId}`,
  ]);
  await pool.query("INSERT INTO moves(id, slug) VALUES ($1, $2)", [
    moveId,
    `pvp-start-move-${moveId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Startmon', $4, 50, 50, 50, 50, 50, 50)`,
    [randomUUID(), contentReleaseId, formId, typeId],
  );
  await pool.query(
    `INSERT INTO ability_revisions(
       id, content_release_id, ability_id, display_name, effect_config
     ) VALUES ($1, $2, $3, 'Start Ability', '{}'::jsonb)`,
    [randomUUID(), contentReleaseId, abilityId],
  );
  await pool.query(
    `INSERT INTO nature_revisions(
       id, content_release_id, nature_id, display_name, increased_stat, decreased_stat
     ) VALUES ($1, $2, $3, 'Neutral', NULL, NULL)`,
    [randomUUID(), contentReleaseId, natureId],
  );
  await pool.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, priority, max_pp, effect_config, flags
     ) VALUES (
       $1, $2, $3, 'Start Move', $4, 'PHYSICAL',
       40, 100, 0, 35, '{}'::jsonb,
       '{"schemaVersion":1,"makesContact":true}'::jsonb
     )`,
    [randomUUID(), contentReleaseId, moveId, typeId],
  );

  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = $2,
         validation_report = '{"test_fixture":true}'::jsonb,
         config_fingerprint = $3
     WHERE id = $1`,
    [rulesetId, publishedAt, "b".repeat(64)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'PUBLISHED', published_at = $2
     WHERE id = $1`,
    [rulesetId, publishedAt],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = $2,
         validation_report = '{"test_fixture":true}'::jsonb,
         content_fingerprint = $3
     WHERE id = $1`,
    [contentReleaseId, publishedAt, "c".repeat(64)],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'PUBLISHED', published_at = $2
     WHERE id = $1`,
    [contentReleaseId, publishedAt],
  );

  return {
    areaId,
    contentReleaseId,
    rulesetId,
    formId,
    abilityId,
    natureId,
    moveId,
  };
}

async function seedPlayer(
  pool: Pool,
  catalog: CatalogFixture,
  currentHps: readonly number[],
): Promise<{ playerId: string; pokemonIds: readonly string[] }> {
  const playerId = randomUUID();
  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await pool.query(
    `INSERT INTO onboarding_states(player_id, state, completed_at)
     VALUES ($1, 'COMPLETE', now())`,
    [playerId],
  );
  await pool.query(
    `INSERT INTO player_identities(id, player_id, provider, external_id, status)
     VALUES ($1, $2, 'WHATSAPP', $3, 'ACTIVE')`,
    [randomUUID(), playerId, `pvp-start-${playerId}`],
  );
  await pool.query("INSERT INTO player_locations(player_id, area_id) VALUES ($1, $2)", [
    playerId,
    catalog.areaId,
  ]);

  const pokemonIds: string[] = [];
  for (const [index, currentHp] of currentHps.entries()) {
    const pokemonId = randomUUID();
    pokemonIds.push(pokemonId);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, ability_id,
         origin_type, status
       ) VALUES ($1, $2, $3, 10, $4, $5, 'PVP_TEST', 'ACTIVE')`,
      [pokemonId, playerId, catalog.formId, currentHp, catalog.abilityId],
    );
    await pool.query(
      `INSERT INTO pokemon_training_values(
         pokemon_instance_id, nature_id,
         iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed
       ) VALUES ($1, $2, 10, 10, 10, 10, 10, 10)`,
      [pokemonId, catalog.natureId],
    );
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, 1, $2, 35)`,
      [pokemonId, catalog.moveId],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, 'TEAM', NULL, $3)`,
      [pokemonId, playerId, index + 1],
    );
  }
  return { playerId, pokemonIds };
}

async function seedAcceptedMatch(
  pool: Pool,
  catalog: CatalogFixture,
  challengerHps: readonly number[] = [20, 18],
  targetHps: readonly number[] = [20, 0],
): Promise<AcceptedMatchFixture> {
  const challenger = await seedPlayer(pool, catalog, challengerHps);
  const target = await seedPlayer(pool, catalog, targetHps);
  const challengeId = randomUUID();
  const encounterId = randomUUID();
  const acceptedAt = new Date("2026-08-31T12:01:00.000Z");

  await pool.query(
    `INSERT INTO encounters(
       id, player_id, area_id, status, content_release_id, ruleset_id, mode,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
       rng_counter, revision, creation_idempotency_key, created_at, updated_at, expires_at
     ) VALUES (
       $1, $2, $3, 'PRESENTED', $4, $5, 'PVP',
       $6, $7, $8, 1, 0, 0, $9, $10, $10, NULL
     )`,
    [
      encounterId,
      challenger.playerId,
      catalog.areaId,
      catalog.contentReleaseId,
      catalog.rulesetId,
      Buffer.alloc(32, 11),
      Buffer.alloc(12, 12),
      Buffer.alloc(16, 13),
      `pvp-challenge:${challengeId}`,
      acceptedAt,
    ],
  );
  await pool.query(
    `INSERT INTO encounter_players(encounter_id, player_id, side_no, role, active)
     VALUES
       ($1, $2, 1, 'CHALLENGER', TRUE),
       ($1, $3, 2, 'TARGET', TRUE)`,
    [encounterId, challenger.playerId, target.playerId],
  );
  await pool.query(
    `INSERT INTO pvp_challenges(
       id, challenger_player_id, target_player_id, status, format_key, reach_policy,
       area_id, content_release_id, ruleset_id, creation_idempotency_key,
       request_fingerprint, encounter_id, battle_id, revision,
       created_at, updated_at, expires_at, accepted_at, started_at, closed_at
     ) VALUES (
       $1, $2, $3, 'ACCEPTED', '1V1', 'SAME_AREA',
       $4, $5, $6, $7,
       $8, $9, NULL, 1,
       $10, $11, $12, $11, NULL, NULL
     )`,
    [
      challengeId,
      challenger.playerId,
      target.playerId,
      catalog.areaId,
      catalog.contentReleaseId,
      catalog.rulesetId,
      `start-create-${challengeId}`,
      "a".repeat(64),
      encounterId,
      new Date("2026-08-31T12:00:00.000Z"),
      acceptedAt,
      new Date("2026-08-31T12:05:00.000Z"),
    ],
  );

  return {
    challengeId,
    encounterId,
    challengerPlayerId: challenger.playerId,
    targetPlayerId: target.playerId,
    eligiblePokemonIds: [
      ...challenger.pokemonIds.filter((_, index) => (challengerHps[index] ?? 0) > 0),
      ...target.pokemonIds.filter((_, index) => (targetHps[index] ?? 0) > 0),
    ],
  };
}

describe("PVP START PostgreSQL atomicity", () => {
  const dbName = `pokemon_pvp_start_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let catalog: CatalogFixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "flow003-pvp-start-vitest" });
    catalog = await seedCatalog(pool);
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

  it("serializes concurrent START calls into one Battle snapshot and one initial TurnWindow", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);
    const startedAt = new Date("2026-08-31T12:02:00.000Z");
    const deadlineAt = new Date("2026-08-31T12:07:00.000Z");

    const [challengerStart, targetStart] = await Promise.all([
      repository.start({
        challengeId: fixture.challengeId,
        actorPlayerId: fixture.challengerPlayerId,
        startedAt,
        deadlineAt,
      }),
      repository.start({
        challengeId: fixture.challengeId,
        actorPlayerId: fixture.targetPlayerId,
        startedAt,
        deadlineAt,
      }),
    ]);

    expect(challengerStart.ok).toBe(true);
    expect(targetStart.ok).toBe(true);
    if (!challengerStart.ok || !targetStart.ok) return;

    expect(challengerStart.value.challengeId).toBe(fixture.challengeId);
    expect(targetStart.value.challengeId).toBe(fixture.challengeId);
    expect(targetStart.value.encounterId).toBe(challengerStart.value.encounterId);
    expect(targetStart.value.battleId).toBe(challengerStart.value.battleId);
    expect(targetStart.value.turnWindowId).toBe(challengerStart.value.turnWindowId);
    expect(new Set([challengerStart.value.replayed, targetStart.value.replayed])).toEqual(
      new Set([false, true]),
    );
    expect(seedProvider.calls).toBe(1);

    const battleId = challengerStart.value.battleId;
    const challenge = await pool.query<{ status: string; battle_id: string | null }>(
      "SELECT status, battle_id FROM pvp_challenges WHERE id = $1",
      [fixture.challengeId],
    );
    expect(challenge.rows[0]).toEqual({ status: "STARTED", battle_id: battleId });

    const encounter = await pool.query<{ status: string }>(
      "SELECT status FROM encounters WHERE id = $1",
      [fixture.encounterId],
    );
    expect(encounter.rows[0]?.status).toBe("IN_BATTLE");

    const battles = await pool.query<{
      id: string;
      battle_type: string;
      status: string;
      encounter_id: string | null;
    }>(
      `SELECT id, battle_type, status, encounter_id
       FROM battles
       WHERE encounter_id = $1`,
      [fixture.encounterId],
    );
    expect(battles.rows).toEqual([
      {
        id: battleId,
        battle_type: "PVP",
        status: "ACTIVE",
        encounter_id: fixture.encounterId,
      },
    ]);

    const sides = await pool.query<{ side_no: number; controller_kind: string; player_id: string }>(
      `SELECT side_no, controller_kind, player_id
       FROM battle_sides
       WHERE battle_id = $1
       ORDER BY side_no`,
      [battleId],
    );
    expect(sides.rows).toEqual([
      { side_no: 1, controller_kind: "PLAYER", player_id: fixture.challengerPlayerId },
      { side_no: 2, controller_kind: "PLAYER", player_id: fixture.targetPlayerId },
    ]);

    const participants = await pool.query<{ pokemon_instance_id: string }>(
      `SELECT pokemon_instance_id
       FROM battle_participants
       WHERE battle_id = $1
       ORDER BY pokemon_instance_id`,
      [battleId],
    );
    expect(participants.rows.map((row) => row.pokemon_instance_id).sort()).toEqual(
      [...fixture.eligiblePokemonIds].sort(),
    );

    const snapshots = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battle_state_snapshots WHERE battle_id = $1 AND version = 0",
      [battleId],
    );
    expect(snapshots.rows[0]?.count).toBe("1");

    const windows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM battle_turn_windows
       WHERE battle_id = $1 AND battle_version = 0`,
      [battleId],
    );
    expect(windows.rows).toEqual([
      { id: challengerStart.value.turnWindowId, status: "COLLECTING" },
    ]);
    const required = await pool.query<{ player_id: string }>(
      `SELECT player_id
       FROM battle_turn_window_required_players
       WHERE turn_window_id = $1
       ORDER BY player_id`,
      [challengerStart.value.turnWindowId],
    );
    expect(required.rows.map((row) => row.player_id).sort()).toEqual(
      [fixture.challengerPlayerId, fixture.targetPlayerId].sort(),
    );
  }, 30_000);

  it("rejects START when either player has no living eligible TEAM Pokemon", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog, [20], [0]);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);

    const result = await repository.start({
      challengeId: fixture.challengeId,
      actorPlayerId: fixture.challengerPlayerId,
      startedAt: new Date("2026-08-31T12:02:00.000Z"),
      deadlineAt: new Date("2026-08-31T12:07:00.000Z"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLAYER_INELIGIBLE");
    expect(seedProvider.calls).toBe(0);
  });

  it("rolls back Battle, snapshot and lifecycle links when TurnWindow creation fails", async () => {
    const fixture = await seedAcceptedMatch(pool, catalog, [20], [20]);
    const seedProvider = new CountingSeedProvider();
    const repository = new PostgresPvpStartRepository(pool, seedProvider);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_pvp_start_turn_window()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'forced turn-window failure';
      END;
      $$;
      CREATE TRIGGER trg_fail_pvp_start_turn_window
      BEFORE INSERT ON battle_turn_windows
      FOR EACH ROW EXECUTE FUNCTION fail_pvp_start_turn_window();
    `);

    try {
      await expect(
        repository.start({
          challengeId: fixture.challengeId,
          actorPlayerId: fixture.targetPlayerId,
          startedAt: new Date("2026-08-31T12:02:00.000Z"),
          deadlineAt: new Date("2026-08-31T12:07:00.000Z"),
        }),
      ).rejects.toThrow("forced turn-window failure");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS trg_fail_pvp_start_turn_window ON battle_turn_windows",
      );
      await pool.query("DROP FUNCTION IF EXISTS fail_pvp_start_turn_window() CASCADE");
    }

    const challenge = await pool.query<{
      status: string;
      battle_id: string | null;
    }>("SELECT status, battle_id FROM pvp_challenges WHERE id = $1", [fixture.challengeId]);
    expect(challenge.rows[0]).toEqual({ status: "ACCEPTED", battle_id: null });

    const encounter = await pool.query<{ status: string }>(
      "SELECT status FROM encounters WHERE id = $1",
      [fixture.encounterId],
    );
    expect(encounter.rows[0]?.status).toBe("PRESENTED");

    const battleCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battles WHERE encounter_id = $1",
      [fixture.encounterId],
    );
    expect(battleCount.rows[0]?.count).toBe("0");
  }, 30_000);
});
