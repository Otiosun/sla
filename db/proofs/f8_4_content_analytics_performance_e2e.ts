import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the F8.4 content analytics performance proof");
}

const AS_OF = new Date("2026-09-03T12:00:00.000Z");
const TOTAL_ROWS_PER_DOMAIN = 50_100;
const RECENT_ROWS_PER_DOMAIN = 100;
const MAX_EXECUTION_MS = 1_500;

const EXPECTED_INDEXES = [
  "idx_encounters_created_at",
  "idx_encounters_closed_at",
  "idx_capture_attempts_created_at",
  "idx_capture_attempts_status_resolved_at",
  "idx_pokemon_xp_ledger_created_at",
  "idx_pokemon_evolution_claims_evolved_at",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planText(plan: unknown): string {
  return JSON.stringify(plan);
}

function assertExecutedFastEnough(plan: unknown, label: string): void {
  assert(Array.isArray(plan), `${label} EXPLAIN did not return JSON plan array`);
  const root = plan[0];
  assert(root !== undefined && typeof root === "object", `${label} EXPLAIN root is missing`);
  const executionTime = Number((root as Record<string, unknown>)["Execution Time"]);
  assert(Number.isFinite(executionTime), `${label} EXPLAIN ANALYZE did not execute`);
  assert(
    executionTime < MAX_EXECUTION_MS,
    `${label} exceeded ${MAX_EXECUTION_MS}ms execution budget: ${executionTime}ms`,
  );
}

async function seedContentHistory(pool: Pool): Promise<void> {
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
    "INSERT INTO rulesets(id, key, version, engine_contract_version, config, status) VALUES ($1, 'f8-4-performance', 1, 1, '{}'::jsonb, 'DRAFT')",
    [rulesetId],
  );
  await pool.query(
    "INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id) VALUES ($1, 8499, 'F8.4 performance proof', 'DRAFT', $2)",
    [releaseId, rulesetId],
  );
  await pool.query("INSERT INTO regions(id, slug) VALUES ($1, 'f8-4-performance-region')", [
    regionId,
  ]);
  await pool.query(
    "INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, 'f8-4-performance-area')",
    [areaId, regionId],
  );
  await pool.query(
    "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 8499, 'f8-4-performance-species')",
    [speciesId],
  );
  await pool.query(
    "INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $3, 'from'), ($2, $3, 'to')",
    [fromFormId, toFormId, speciesId],
  );
  await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-4-performance-ball')", [itemId]);
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, xp, current_hp, origin_type, captured_at, created_at, updated_at
     ) VALUES ($1,$2,$3,10,100,20,'CAPTURE',$4,$4,$4)`,
    [pokemonId, playerId, fromFormId, new Date("2026-08-10T00:00:00.000Z")],
  );
  await pool.query(
    `INSERT INTO evolution_rules(
       id, content_release_id, from_form_id, to_form_id, trigger_kind, trigger_config
     ) VALUES ($1,$2,$3,$4,'LEVEL','{"level":10}'::jsonb)`,
    [evolutionRuleId, releaseId, fromFormId, toFormId],
  );

  await pool.query(
    `INSERT INTO encounters(
       id, player_id, area_id, status, content_release_id, ruleset_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
       created_at, updated_at, closed_at
     )
     SELECT
       md5('f8.4-encounter-' || series)::uuid,
       $1::uuid,
       $2::uuid,
       'CLOSED',
       $3::uuid,
       $4::uuid,
       decode(repeat('01', 32), 'hex'),
       decode(repeat('02', 12), 'hex'),
       decode(repeat('03', 16), 'hex'),
       1,
       observed_at - interval '1 hour',
       observed_at,
       observed_at
     FROM (
       SELECT series,
              CASE
                WHEN series <= $6::integer
                  THEN $5::timestamptz - interval '1 day' - series * interval '1 second'
                ELSE $5::timestamptz - interval '90 days' - series * interval '1 second'
              END AS observed_at
       FROM generate_series(1, $7::integer) AS generated(series)
     ) seeded`,
    [
      playerId,
      areaId,
      releaseId,
      rulesetId,
      AS_OF,
      RECENT_ROWS_PER_DOMAIN,
      TOTAL_ROWS_PER_DOMAIN,
    ],
  );

  const encounterId = await pool.query<{ id: string }>(
    "SELECT id FROM encounters WHERE player_id = $1 ORDER BY created_at DESC LIMIT 1",
    [playerId],
  );
  const sourceEncounterId = encounterId.rows[0]?.id;
  assert(sourceEncounterId !== undefined, "F8.4 performance fixture encounter is missing");

  await pool.query(
    `INSERT INTO capture_attempts(
       id, player_id, encounter_id, ball_item_id, idempotency_key, status,
       probability_basis_points, roll_basis_points, created_at, resolved_at,
       request_fingerprint, source_encounter_status, correlation_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version, rng_counter, breakdown
     )
     SELECT
       md5('f8.4-capture-' || series)::uuid,
       $1::uuid,
       $2::uuid,
       $3::uuid,
       'f8.4-performance-capture-' || series,
       'FAILED',
       5000,
       9000,
       observed_at - interval '1 hour',
       observed_at,
       md5('f8.4-capture-fingerprint-a-' || series) || md5('f8.4-capture-fingerprint-b-' || series),
       'ENGAGED',
       md5('f8.4-capture-correlation-' || series)::uuid,
       decode(repeat('01', 32), 'hex'),
       decode(repeat('02', 12), 'hex'),
       decode(repeat('03', 16), 'hex'),
       1,
       1,
       '{}'::jsonb
     FROM (
       SELECT series,
              CASE
                WHEN series <= $5::integer
                  THEN $4::timestamptz - interval '1 day' - series * interval '1 second'
                ELSE $4::timestamptz - interval '90 days' - series * interval '1 second'
              END AS observed_at
       FROM generate_series(1, $6::integer) AS generated(series)
     ) seeded`,
    [
      playerId,
      sourceEncounterId,
      itemId,
      AS_OF,
      RECENT_ROWS_PER_DOMAIN,
      TOTAL_ROWS_PER_DOMAIN,
    ],
  );

  await pool.query(
    `INSERT INTO pokemon_xp_ledger(
       id, pokemon_instance_id, awarded_xp, before_level, after_level, before_xp, after_xp,
       content_release_id, ruleset_id, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     )
     SELECT
       md5('f8.4-xp-id-' || series)::uuid,
       $1::uuid,
       1,
       10,
       10,
       100,
       101,
       $2::uuid,
       $3::uuid,
       'F8_4_PERFORMANCE',
       series::text,
       'F8.4 temporal index proof',
       'SYSTEM',
       'f8.4-performance-xp',
       md5('f8.4-xp-key-a-' || series) || md5('f8.4-xp-key-b-' || series),
       md5('f8.4-xp-correlation-' || series)::uuid,
       CASE
         WHEN series <= $5::integer
           THEN $4::timestamptz - interval '1 day' - series * interval '1 second'
         ELSE $4::timestamptz - interval '90 days' - series * interval '1 second'
       END
     FROM generate_series(1, $6::integer) AS generated(series)`,
    [pokemonId, releaseId, rulesetId, AS_OF, RECENT_ROWS_PER_DOMAIN, TOTAL_ROWS_PER_DOMAIN],
  );

  await pool.query(
    `INSERT INTO pokemon_evolution_claims(
       id, pokemon_instance_id, content_release_id, ruleset_id, evolution_rule_id,
       from_form_id, to_form_id, trigger_kind, source_type, source_id,
       idempotency_scope, idempotency_key, request_fingerprint, correlation_id, result, evolved_at
     )
     SELECT
       md5('f8.4-evolution-id-' || series)::uuid,
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::uuid,
       $6::uuid,
       'LEVEL',
       'F8_4_PERFORMANCE',
       series::text,
       'f8.4-performance-evolution',
       md5('f8.4-evolution-key-a-' || series) || md5('f8.4-evolution-key-b-' || series),
       md5('f8.4-evolution-fingerprint-a-' || series) || md5('f8.4-evolution-fingerprint-b-' || series),
       md5('f8.4-evolution-correlation-' || series)::uuid,
       '{}'::jsonb,
       CASE
         WHEN series <= $8::integer
           THEN $7::timestamptz - interval '1 day' - series * interval '1 second'
         ELSE $7::timestamptz - interval '90 days' - series * interval '1 second'
       END
     FROM generate_series(1, $9::integer) AS generated(series)`,
    [
      pokemonId,
      releaseId,
      rulesetId,
      evolutionRuleId,
      fromFormId,
      toFormId,
      AS_OF,
      RECENT_ROWS_PER_DOMAIN,
      TOTAL_ROWS_PER_DOMAIN,
    ],
  );

  await pool.query("ANALYZE encounters");
  await pool.query("ANALYZE capture_attempts");
  await pool.query("ANALYZE pokemon_xp_ledger");
  await pool.query("ANALYZE pokemon_evolution_claims");
}

async function provePlan(
  pool: Pool,
  label: string,
  expectedIndex: (typeof EXPECTED_INDEXES)[number],
  sql: string,
): Promise<void> {
  const explain = await pool.query<{ "QUERY PLAN": unknown }>(sql, [AS_OF]);
  const plan = explain.rows[0]?.["QUERY PLAN"];
  const text = planText(plan);
  assert(
    text.includes(expectedIndex),
    `${label} did not use ${expectedIndex}: ${text}`,
  );
  assertExecutedFastEnough(plan, label);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000 });
  try {
    await seedContentHistory(pool);

    await provePlan(
      pool,
      "F8.4 encounter-created 30d aggregate",
      "idx_encounters_created_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*)
       FROM encounters
       WHERE created_at >= $1::timestamptz - interval '30 days'
         AND created_at < $1::timestamptz`,
    );
    await provePlan(
      pool,
      "F8.4 encounter-closed 30d aggregate",
      "idx_encounters_closed_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*)
       FROM encounters
       WHERE closed_at >= $1::timestamptz - interval '30 days'
         AND closed_at < $1::timestamptz`,
    );
    await provePlan(
      pool,
      "F8.4 capture-created 30d aggregate",
      "idx_capture_attempts_created_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*)
       FROM capture_attempts
       WHERE created_at >= $1::timestamptz - interval '30 days'
         AND created_at < $1::timestamptz`,
    );
    await provePlan(
      pool,
      "F8.4 capture-resolved 30d aggregate",
      "idx_capture_attempts_status_resolved_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*)
       FROM capture_attempts
       WHERE status = 'FAILED'
         AND resolved_at >= $1::timestamptz - interval '30 days'
         AND resolved_at < $1::timestamptz`,
    );
    await provePlan(
      pool,
      "F8.4 XP 30d aggregate",
      "idx_pokemon_xp_ledger_created_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*), COALESCE(sum(awarded_xp), 0)
       FROM pokemon_xp_ledger
       WHERE created_at >= $1::timestamptz - interval '30 days'
         AND created_at < $1::timestamptz`,
    );
    await provePlan(
      pool,
      "F8.4 evolution 30d aggregate",
      "idx_pokemon_evolution_claims_evolved_at",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT count(*)
       FROM pokemon_evolution_claims
       WHERE evolved_at >= $1::timestamptz - interval '30 days'
         AND evolved_at < $1::timestamptz`,
    );

    process.stdout.write(
      `${JSON.stringify({ proof: "f8.4-content-analytics-performance", rowsPerDomain: TOTAL_ROWS_PER_DOMAIN, recentRowsPerDomain: RECENT_ROWS_PER_DOMAIN, indexes: EXPECTED_INDEXES })}\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
