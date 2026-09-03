import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresGameplayAnalyticsRepository } from "../../src/platform/admin/postgres-gameplay-analytics-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function dbUrl(name: string) {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("F8.4 gameplay subgroup privacy", () => {
  const dbName = `pokemon_gameplay_subgroup_privacy_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-02T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;
  let releaseId: string;
  let rulesetId: string;
  let areaId: string;
  let formId: string;
  let ballItemId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "gameplay-subgroup-privacy-proof" });

    rulesetId = randomUUID();
    releaseId = randomUUID();
    const regionId = randomUUID();
    areaId = randomUUID();
    const speciesId = randomUUID();
    formId = randomUUID();
    ballItemId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId, `f8-4-subgroup-${rulesetId}`],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 99993, 'F8.4 subgroup privacy proof', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
      regionId,
      `f8-4-subgroup-region-${regionId}`,
    ]);
    await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
      areaId,
      regionId,
      `f8-4-subgroup-area-${areaId}`,
    ]);
    await pool.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9993, $2)", [
      speciesId,
      `f8-4-subgroup-mon-${speciesId}`,
    ]);
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'base')", [
      formId,
      speciesId,
    ]);
    await pool.query("INSERT INTO items(id, slug) VALUES ($1, $2)", [
      ballItemId,
      `f8-4-subgroup-ball-${ballItemId}`,
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

  it("does not let a five-player domain cohort expose one-player outcome or sign cells", async () => {
    const players = Array.from({ length: 5 }, () => randomUUID());
    const encounterIds: string[] = [];
    for (const playerId of players) {
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    }

    for (let index = 0; index < players.length; index += 1) {
      const playerId = players[index];
      if (playerId === undefined) throw new Error("subgroup privacy player fixture missing");
      const encounterId = randomUUID();
      encounterIds.push(encounterId);
      const createdAt = new Date(`2026-09-02T0${index + 1}:00:00.000Z`);
      const closedHour = String(index + 6).padStart(2, "0");
      const closedAt = new Date(`2026-09-02T${closedHour}:00:00.000Z`);
      const encounterStatus = index === 0 ? "CAPTURED" : "FLED";
      await pool.query(
        `INSERT INTO encounters(
           id, player_id, area_id, status, content_release_id, ruleset_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
           created_at, updated_at, closed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$11)`,
        [
          encounterId,
          playerId,
          areaId,
          encounterStatus,
          releaseId,
          rulesetId,
          Buffer.alloc(32, index + 1),
          Buffer.alloc(12, index + 1),
          Buffer.alloc(16, index + 1),
          createdAt,
          closedAt,
        ],
      );

      const captureStatus = index === 0 ? "CAPTURED" : "FAILED";
      let pokemonInstanceId: string | null = null;
      if (captureStatus === "CAPTURED") {
        pokemonInstanceId = randomUUID();
        await pool.query(
          `INSERT INTO pokemon_instances(
             id, owner_player_id, form_id, level, current_hp, status, origin_type,
             captured_at, created_at, updated_at
           ) VALUES ($1,$2,$3,5,20,'ACTIVE','CAPTURE',$4,$4,$4)`,
          [pokemonInstanceId, playerId, formId, closedAt],
        );
      }
      await pool.query(
        `INSERT INTO capture_attempts(
           id, player_id, encounter_id, ball_item_id, idempotency_key, status,
           probability_basis_points, roll_basis_points, pokemon_instance_id, created_at, resolved_at,
           request_fingerprint, source_encounter_status, correlation_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter,
           breakdown
         ) VALUES (
           $1,$2,$3,$4,$5,$6,5000,1000,$7,$8,$8,
           $9,'ENGAGED',$10,$11,$12,$13,1,1,'{}'::jsonb
         )`,
        [
          randomUUID(),
          playerId,
          encounterId,
          ballItemId,
          `f8-4-subgroup-capture-${index}`,
          captureStatus,
          pokemonInstanceId,
          closedAt,
          `${index + 1}`.repeat(64).slice(0, 64),
          randomUUID(),
          Buffer.alloc(32, index + 11),
          Buffer.alloc(12, index + 11),
          Buffer.alloc(16, index + 11),
        ],
      );

      await pool.query(
        `INSERT INTO trainer_progress_ledger(
           id, player_id, delta, source_type, source_id, actor_type,
           idempotency_scope, idempotency_key, created_at
         ) VALUES ($1,$2,$3,'F8_4_SUBGROUP_TEST',$4,'SYSTEM','f8.4.subgroup',$5,$6)`,
        [
          randomUUID(),
          playerId,
          index === 0 ? "-10" : "10",
          `subgroup-progress-${index}`,
          `subgroup-progress-${index}`,
          createdAt,
        ],
      );
    }

    const result = await new PostgresGameplayAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    const day = result.windows.find((window) => window.window === "24h");

    expect(day).toBeDefined();
    expect(day?.encounters.created).toEqual({ suppressed: false, count: "5" });
    expect(day?.encounters.closures).toEqual({ suppressed: true });
    expect(day?.captures).toEqual({ suppressed: true });
    expect(day?.trainerProgression).toEqual({ suppressed: true });
  });
});
