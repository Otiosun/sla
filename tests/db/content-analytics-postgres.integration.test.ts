import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresContentAnalyticsRepository } from "../../src/platform/admin/postgres-content-analytics-repository.js";
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

const HEX64 = "a".repeat(64);
const RNG_CIPHERTEXT = Buffer.alloc(32, 1);
const RNG_IV = Buffer.alloc(12, 2);
const RNG_TAG = Buffer.alloc(16, 3);

describe.sequential("PostgresContentAnalyticsRepository", () => {
  const dbName = `pokemon_content_analytics_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-03T12:00:00.000Z");
  const lowerBound = new Date("2026-08-04T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "content-analytics-proof" });
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

  it("aggregates only authoritative 30d encounter, capture and progression evidence with an exclusive asOf upper bound", async () => {
    const playerId = randomUUID();
    const rulesetId = randomUUID();
    const releaseId = randomUUID();
    const regionId = randomUUID();
    const areaId = randomUUID();
    const speciesId = randomUUID();
    const fromFormId = randomUUID();
    const toFormId = randomUUID();
    const itemId = randomUUID();
    const pokemonId = randomUUID();
    const evolutionRuleId = randomUUID();

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO rulesets(id, key, version, engine_contract_version, config, status) VALUES ($1, 'f8-4', 1, 1, '{}'::jsonb, 'DRAFT')",
      [rulesetId],
    );
    await pool.query(
      "INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id) VALUES ($1, 8401, 'F8.4 proof', 'DRAFT', $2)",
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, 'f8-4-region')", [regionId]);
    await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, 'f8-4-area')", [
      areaId,
      regionId,
    ]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 8401, 'f8-4-species')",
      [speciesId],
    );
    await pool.query(
      "INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $3, 'from'), ($2, $3, 'to')",
      [fromFormId, toFormId, speciesId],
    );
    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-4-ball')", [itemId]);
    await pool.query(
      `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, xp, current_hp, origin_type, captured_at, created_at, updated_at)
       VALUES ($1,$2,$3,10,100,20,'CAPTURE',$4,$4,$4)`,
      [pokemonId, playerId, fromFormId, new Date("2026-08-10T00:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO evolution_rules(id, content_release_id, from_form_id, to_form_id, trigger_kind, trigger_config)
       VALUES ($1,$2,$3,$4,'LEVEL','{"level":10}'::jsonb)`,
      [evolutionRuleId, releaseId, fromFormId, toFormId],
    );

    const encounterRows = [
      {
        id: randomUUID(),
        status: "CLOSED",
        createdAt: lowerBound,
        closedAt: new Date("2026-08-05T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        status: "FLED",
        createdAt: new Date("2026-08-04T11:59:59.999Z"),
        closedAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        status: "EXPIRED",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        closedAt: asOf,
      },
      {
        id: randomUUID(),
        status: "CREATED",
        createdAt: asOf,
        closedAt: null,
      },
    ] as const;

    for (const row of encounterRows) {
      await pool.query(
        `INSERT INTO encounters(
           id, player_id, area_id, status, content_release_id, ruleset_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
           created_at, updated_at, closed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10,$11)`,
        [
          row.id,
          playerId,
          areaId,
          row.status,
          releaseId,
          rulesetId,
          RNG_CIPHERTEXT,
          RNG_IV,
          RNG_TAG,
          row.createdAt,
          row.closedAt,
        ],
      );
    }

    const captureRows = [
      {
        id: randomUUID(),
        status: "FAILED",
        createdAt: lowerBound,
        resolvedAt: new Date("2026-08-07T00:00:00.000Z"),
        pokemonInstanceId: null,
      },
      {
        id: randomUUID(),
        status: "CAPTURED",
        createdAt: new Date("2026-08-04T11:59:59.999Z"),
        resolvedAt: new Date("2026-08-08T00:00:00.000Z"),
        pokemonInstanceId: pokemonId,
      },
      {
        id: randomUUID(),
        status: "PENDING",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        resolvedAt: null,
        pokemonInstanceId: null,
      },
      {
        id: randomUUID(),
        status: "FAILED",
        createdAt: new Date("2026-08-21T00:00:00.000Z"),
        resolvedAt: asOf,
        pokemonInstanceId: null,
      },
    ] as const;

    for (const [index, row] of captureRows.entries()) {
      await pool.query(
        `INSERT INTO capture_attempts(
           id, player_id, encounter_id, ball_item_id, idempotency_key, status,
           probability_basis_points, roll_basis_points, pokemon_instance_id, created_at, resolved_at,
           request_fingerprint, source_encounter_status, correlation_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter, breakdown
         ) VALUES (
           $1,$2,$3,$4,$5,$6,5000,1000,$7,$8,$9,$10,'ENGAGED',$11,$12,$13,$14,1,1,'{}'::jsonb
         )`,
        [
          row.id,
          playerId,
          encounterRows[0].id,
          itemId,
          `f8-4-capture-${index}`,
          row.status,
          row.pokemonInstanceId,
          row.createdAt,
          row.resolvedAt,
          `${index}`.padStart(64, "a").slice(-64),
          randomUUID(),
          RNG_CIPHERTEXT,
          RNG_IV,
          RNG_TAG,
        ],
      );
    }

    const xpRows = [
      { xp: 5, at: lowerBound, suffix: "1" },
      { xp: 7, at: new Date("2026-08-04T11:59:59.999Z"), suffix: "2" },
      { xp: 11, at: asOf, suffix: "3" },
    ] as const;
    for (const row of xpRows) {
      await pool.query(
        `INSERT INTO pokemon_xp_ledger(
           id, pokemon_instance_id, awarded_xp, before_level, after_level, before_xp, after_xp,
           content_release_id, ruleset_id, source_type, source_id, reason, actor_type,
           idempotency_scope, idempotency_key, correlation_id, created_at
         ) VALUES ($1,$2,$3,10,10,100,$4,$5,$6,'F8_4_TEST',$7,'aggregate proof','SYSTEM','f8.4-test',$8,$9,$10)`,
        [
          randomUUID(),
          pokemonId,
          row.xp,
          100 + row.xp,
          releaseId,
          rulesetId,
          `xp-${row.suffix}`,
          `${row.suffix}`.repeat(64),
          randomUUID(),
          row.at,
        ],
      );
    }

    const evolutionRows = [
      { at: lowerBound, suffix: "4" },
      { at: new Date("2026-08-04T11:59:59.999Z"), suffix: "5" },
      { at: asOf, suffix: "6" },
    ] as const;
    for (const row of evolutionRows) {
      await pool.query(
        `INSERT INTO pokemon_evolution_claims(
           id, pokemon_instance_id, content_release_id, ruleset_id, evolution_rule_id,
           from_form_id, to_form_id, trigger_kind, source_type, source_id,
           idempotency_scope, idempotency_key, request_fingerprint, correlation_id, result, evolved_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'LEVEL','F8_4_TEST',$8,'f8.4-evolution',$9,$10,$11,'{}'::jsonb,$12)`,
        [
          randomUUID(),
          pokemonId,
          releaseId,
          rulesetId,
          evolutionRuleId,
          fromFormId,
          toFormId,
          `evolution-${row.suffix}`,
          `${row.suffix}`.repeat(64),
          HEX64,
          randomUUID(),
          row.at,
        ],
      );
    }

    const result = await new PostgresContentAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );

    expect(result).toEqual({
      encounters: { created: "2", closed: "2" },
      captures: { attemptsCreated: "3", captured: "1", failed: "1" },
      progression: { xpAwards: "1", xpAwarded: "5", evolutions: "1" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(playerId);
    expect(serialized).not.toContain("F8_4_TEST");
    expect(serialized).not.toContain("aggregate proof");
  });
});
