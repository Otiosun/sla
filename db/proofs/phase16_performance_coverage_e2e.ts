import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { PostgresPlayer360Repository } from "../../src/platform/admin/postgres-player360-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for Phase 16 performance coverage proof");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function executionTimeMs(plan: unknown): number {
  if (!Array.isArray(plan)) throw new Error("EXPLAIN JSON did not return an array");
  const root = plan[0];
  if (typeof root !== "object" || root === null || !("Execution Time" in root)) {
    throw new Error(`EXPLAIN ANALYZE did not expose Execution Time: ${JSON.stringify(plan)}`);
  }
  const value = (root as { readonly "Execution Time": unknown })["Execution Time"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid EXPLAIN execution time: ${String(value)}`);
  }
  return value;
}

async function seedOperationalFixtures(pool: Pool): Promise<{
  readonly playerIds: readonly string[];
  readonly samplePlayerId: string;
}> {
  const players = await pool.query<{ id: string }>(
    `SELECT player.id
     FROM players player
     JOIN player_profiles profile ON profile.player_id = player.id
     WHERE profile.trainer_name LIKE 'Perf-%'
     ORDER BY player.created_at DESC, player.id DESC
     LIMIT 400`,
  );
  const playerIds = players.rows.map((row) => row.id);
  assert(playerIds.length === 400, `Expected 400 existing performance players, got ${playerIds.length}`);

  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const itemId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `phase16-performance-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 160910, 'Phase 16 performance coverage', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
    regionId,
    `phase16-performance-${regionId}`,
  ]);
  await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
    areaId,
    regionId,
    `phase16-performance-${areaId}`,
  ]);
  await pool.query("INSERT INTO items(id, slug) VALUES ($1, $2)", [
    itemId,
    `phase16-performance-${itemId}`,
  ]);
  await pool.query(
    "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 32000, $2)",
    [speciesId, `phase16-performance-${speciesId}`],
  );
  await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);

  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity)
     SELECT id, $2, 25
     FROM unnest($1::uuid[]) AS seeded(id)`,
    [playerIds, itemId],
  );

  const pokemonIds = playerIds.map(() => randomUUID());
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, current_hp, origin_type, metadata
     )
     SELECT pokemon_id, player_id, $3, 10, 30, 'PERFORMANCE_PROOF', '{}'::jsonb
     FROM unnest($1::uuid[], $2::uuid[]) AS seeded(pokemon_id, player_id)`,
    [pokemonIds, playerIds, formId],
  );
  await pool.query(
    `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, slot_no)
     SELECT pokemon_id, player_id, 'TEAM', 1
     FROM unnest($1::uuid[], $2::uuid[]) AS seeded(pokemon_id, player_id)`,
    [pokemonIds, playerIds],
  );

  const encounterIds = playerIds.map(() => randomUUID());
  await pool.query(
    `INSERT INTO encounters(
       id, player_id, area_id, status, content_release_id, ruleset_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
     )
     SELECT encounter_id, player_id, $3, 'ENGAGED', $4, $5,
            decode(repeat('11', 32), 'hex'), decode(repeat('22', 12), 'hex'),
            decode(repeat('33', 16), 'hex'), 1
     FROM unnest($1::uuid[], $2::uuid[]) AS seeded(encounter_id, player_id)`,
    [encounterIds, playerIds, areaId, releaseId, rulesetId],
  );

  const battleIds = playerIds.map(() => randomUUID());
  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
     )
     SELECT battle_id, 'PERFORMANCE_PROOF', 'ACTIVE', $2, $3,
            decode(repeat('44', 32), 'hex'), decode(repeat('55', 12), 'hex'),
            decode(repeat('66', 16), 'hex'), 1
     FROM unnest($1::uuid[]) AS seeded(battle_id)`,
    [battleIds, releaseId, rulesetId],
  );
  const sideIds = playerIds.map(() => randomUUID());
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     SELECT side_id, battle_id, 1, 'PLAYER', player_id
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS seeded(side_id, battle_id, player_id)`,
    [sideIds, battleIds, playerIds],
  );

  await pool.query(
    `INSERT INTO outbox_messages(
       id, channel, destination_ref, message_type, payload, idempotency_key,
       status, attempts, correlation_id, created_at
     )
     SELECT gen_random_uuid(), 'phase16-performance', 'load-destination', 'TEXT',
            jsonb_build_object('text', 'performance-' || ordinal::text),
            'phase16.performance.outbox:' || ordinal::text,
            'PENDING', 0, gen_random_uuid(), now() - (ordinal::text || ' milliseconds')::interval
     FROM generate_series(1, 1000) AS seeded(ordinal)`,
  );

  await Promise.all([
    pool.query("ANALYZE inventory_balances"),
    pool.query("ANALYZE pokemon_instances"),
    pool.query("ANALYZE pokemon_roster_slots"),
    pool.query("ANALYZE encounters"),
    pool.query("ANALYZE battles"),
    pool.query("ANALYZE battle_sides"),
    pool.query("ANALYZE outbox_messages"),
  ]);

  const samplePlayerId = playerIds[0];
  if (samplePlayerId === undefined) throw new Error("Missing sample performance player");
  return { playerIds, samplePlayerId };
}

async function benchmarkCriticalQueries(pool: Pool, playerId: string): Promise<void> {
  const benchmarks: Record<string, number> = {};

  const player360 = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT player.id, player.status, progression.level, progression.progression_points
     FROM players player
     LEFT JOIN trainer_progression progression ON progression.player_id = player.id
     WHERE player.id = $1`,
    [playerId],
  );
  benchmarks.player360 = executionTimeMs(player360.rows[0]?.["QUERY PLAN"]);

  const inventory = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT balance.item_id, item.slug, balance.quantity, balance.revision, balance.updated_at
     FROM inventory_balances balance
     JOIN items item ON item.id = balance.item_id
     WHERE balance.player_id = $1
     ORDER BY item.slug, balance.item_id`,
    [playerId],
  );
  benchmarks.inventory = executionTimeMs(inventory.rows[0]?.["QUERY PLAN"]);

  const team = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT pokemon.id, pokemon.form_id, pokemon.level, roster.slot_no
     FROM pokemon_instances pokemon
     JOIN pokemon_roster_slots roster
       ON roster.pokemon_instance_id = pokemon.id
      AND roster.player_id = pokemon.owner_player_id
     WHERE pokemon.owner_player_id = $1
       AND pokemon.status = 'ACTIVE'
       AND roster.placement_kind = 'TEAM'
     ORDER BY roster.slot_no, pokemon.created_at, pokemon.id`,
    [playerId],
  );
  benchmarks.team = executionTimeMs(team.rows[0]?.["QUERY PLAN"]);

  const encounter = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id, status, area_id, content_release_id, ruleset_id, created_at, updated_at
     FROM encounters
     WHERE player_id = $1
       AND status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [playerId],
  );
  benchmarks.activeEncounter = executionTimeMs(encounter.rows[0]?.["QUERY PLAN"]);

  const battle = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT DISTINCT battle.id, battle.status, battle.battle_type, battle.encounter_id,
            battle.content_release_id, battle.ruleset_id, battle.turn_number,
            battle.version, battle.created_at, battle.updated_at, battle.ended_at
     FROM battles battle
     JOIN battle_sides side ON side.battle_id = battle.id
     WHERE side.player_id = $1
       AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
     ORDER BY battle.created_at DESC, battle.id DESC
     LIMIT 1`,
    [playerId],
  );
  benchmarks.activeBattle = executionTimeMs(battle.rows[0]?.["QUERY PLAN"]);

  const outbox = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id
     FROM outbox_messages
     WHERE status IN ('PENDING', 'FAILED')
       AND attempts < 5
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     ORDER BY created_at, id
     LIMIT 50`,
  );
  benchmarks.outbox = executionTimeMs(outbox.rows[0]?.["QUERY PLAN"]);

  assert(Object.keys(benchmarks).length === 6, "Did not benchmark all six canonical query paths");
  assert(
    Object.values(benchmarks).every((value) => Number.isFinite(value) && value >= 0),
    `Invalid benchmark timings: ${JSON.stringify(benchmarks)}`,
  );
  process.stdout.write(`${JSON.stringify({ phase: "16.10", benchmarksMs: benchmarks })}\n`);
}

async function runMainPathLoad(pool: Pool, playerIds: readonly string[]): Promise<void> {
  const player360 = new PostgresPlayer360Repository(pool);
  const messaging = new PostgresMessagingRepository(pool);
  const readOperations: Array<Promise<unknown>> = [];
  const startedReadsAt = performance.now();

  for (let index = 0; index < 50; index += 1) {
    const playerId = playerIds[index % playerIds.length];
    if (playerId === undefined) throw new Error("Missing load player");
    readOperations.push(player360.getPlayer360(playerId, false));
    readOperations.push(
      pool.query("SELECT quantity FROM inventory_balances WHERE player_id = $1", [playerId]),
    );
    readOperations.push(
      pool.query(
        "SELECT pokemon_instance_id FROM pokemon_roster_slots WHERE player_id = $1 AND placement_kind = 'TEAM' ORDER BY slot_no",
        [playerId],
      ),
    );
    readOperations.push(
      pool.query(
        "SELECT id FROM encounters WHERE player_id = $1 AND status IN ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE') ORDER BY created_at DESC, id DESC LIMIT 1",
        [playerId],
      ),
    );
    readOperations.push(
      pool.query(
        "SELECT battle.id FROM battles battle JOIN battle_sides side ON side.battle_id = battle.id WHERE side.player_id = $1 AND battle.status IN ('CREATED','ACTIVE','RESOLVING_TURN') ORDER BY battle.created_at DESC, battle.id DESC LIMIT 1",
        [playerId],
      ),
    );
  }

  const readResults = await Promise.allSettled(readOperations);
  const readFailures = readResults.filter((result) => result.status === "rejected");
  assert(readFailures.length === 0, `Main-path read load had ${readFailures.length} failures`);
  const readElapsedMs = performance.now() - startedReadsAt;

  let claimedTotal = 0;
  const startedOutboxAt = performance.now();
  for (;;) {
    const claimed = await messaging.claimOutbox({ limit: 50, staleAfterMs: 30_000, maxAttempts: 5 });
    if (claimed.length === 0) break;
    claimedTotal += claimed.length;
    await Promise.all(claimed.map((message) => messaging.markOutboxSent(message.id)));
  }
  const outboxElapsedMs = performance.now() - startedOutboxAt;

  assert(claimedTotal === 1000, `Expected to drain 1000 outbox messages, drained ${claimedTotal}`);
  const outboxState = await pool.query<{ pending: string; sent: string }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('PENDING','FAILED','SENDING'))::text AS pending,
       count(*) FILTER (WHERE status = 'SENT')::text AS sent
     FROM outbox_messages
     WHERE channel = 'phase16-performance'`,
  );
  const row = outboxState.rows[0];
  assert(row?.pending === "0" && row.sent === "1000", `Outbox drain mismatch: ${JSON.stringify(row)}`);
  assert(pool.waitingCount === 0, `Load left ${pool.waitingCount} queued DB requests`);
  assert(pool.totalCount <= 8, `Load exceeded pool max: ${pool.totalCount}`);

  process.stdout.write(
    `${JSON.stringify({
      phase: "16.9",
      mixedReadOperations: readOperations.length,
      mixedReadElapsedMs: Math.round(readElapsedMs),
      outboxMessages: claimedTotal,
      outboxElapsedMs: Math.round(outboxElapsedMs),
    })}\n`,
  );
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
  try {
    const fixture = await seedOperationalFixtures(pool);
    await benchmarkCriticalQueries(pool, fixture.samplePlayerId);
    await runMainPathLoad(pool, fixture.playerIds);
    process.stdout.write(
      "Phase 16 performance coverage proof passed: Player360, inventory, team, active encounter, active battle and outbox benchmarked under real PostgreSQL; mixed main-path load and real outbox claiming drained exactly once.\n",
    );
  } finally {
    await pool.end();
  }
}

await main();
