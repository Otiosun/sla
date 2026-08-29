import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool, type PoolClient } from "pg";
import type { Player360SearchQuery } from "../../src/modules/admin/player360-ports.js";
import { PostgresPlayer360Repository } from "../../src/platform/admin/postgres-player360-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 16 performance proof");
}

const SEARCH_QUERY: Player360SearchQuery = {
  status: "ACTIVE",
  trainerNamePrefix: null,
  originRegionId: null,
  identityProvider: null,
  externalId: null,
  includeSensitive: false,
  limit: 50,
  cursor: null,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planText(plan: unknown): string {
  return JSON.stringify(plan);
}

function createCountingPool(pool: Pool, counter: { value: number }): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return (...args: unknown[]) => {
              counter.value += 1;
              return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
}

async function seedPlayers(pool: Pool, count: number): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await pool.query(
    `INSERT INTO players(id, status, created_at, updated_at)
     SELECT id, 'ACTIVE',
            now() - (ordinality::text || ' seconds')::interval,
            now() - (ordinality::text || ' seconds')::interval
     FROM unnest($1::uuid[]) WITH ORDINALITY AS seeded(id, ordinality)`,
    [ids],
  );
  await pool.query(
    `INSERT INTO trainer_progression(player_id, level, progression_points)
     SELECT id, 5, 500
     FROM unnest($1::uuid[]) AS seeded(id)`,
    [ids],
  );
  await pool.query(
    `INSERT INTO player_profiles(player_id, trainer_name, locale, metadata)
     SELECT id, 'Perf-' || lpad(ordinality::text, 5, '0'), 'pt-BR', '{}'::jsonb
     FROM unnest($1::uuid[]) WITH ORDINALITY AS seeded(id, ordinality)`,
    [ids],
  );
  return ids;
}

async function proveExplainAnalyze(pool: Pool): Promise<void> {
  await pool.query("ANALYZE players");
  await pool.query("ANALYZE player_profiles");
  await pool.query("ANALYZE trainer_progression");

  const searchPlan = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT player.id
     FROM players player
     JOIN trainer_progression progression ON progression.player_id = player.id
     WHERE player.status = 'ACTIVE'
     ORDER BY player.created_at DESC, player.id DESC
     LIMIT 50`,
  );
  const searchPlanText = planText(searchPlan.rows[0]?.["QUERY PLAN"]);
  assert(
    searchPlanText.includes("idx_players_status_created_id") ||
      searchPlanText.includes("idx_players_created_id"),
    `Critical Player360 search did not use a pagination index: ${searchPlanText}`,
  );
  assert(searchPlanText.includes("Actual Total Time"), "Player360 EXPLAIN ANALYZE did not execute");

  const profilePlan = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT player_id
     FROM player_profiles
     WHERE lower(trainer_name) LIKE 'perf-01499%'
     LIMIT 50`,
  );
  const profilePlanText = planText(profilePlan.rows[0]?.["QUERY PLAN"]);
  assert(
    profilePlanText.includes("idx_player_profiles_trainer_name_lower_pattern"),
    `Selective trainer-name prefix query did not use its dedicated index: ${profilePlanText}`,
  );
  assert(profilePlanText.includes("Actual Total Time"), "Profile EXPLAIN ANALYZE did not execute");
}

async function proveNoNPlusOne(pool: Pool): Promise<void> {
  const oneCounter = { value: 0 };
  const oneRepository = new PostgresPlayer360Repository(createCountingPool(pool, oneCounter));
  const one = await oneRepository.searchPlayers({ ...SEARCH_QUERY, limit: 1 });
  assert(one.items.length === 1, "N+1 proof expected one search item");

  const fiftyCounter = { value: 0 };
  const fiftyRepository = new PostgresPlayer360Repository(createCountingPool(pool, fiftyCounter));
  const fifty = await fiftyRepository.searchPlayers({ ...SEARCH_QUERY, limit: 50 });
  assert(fifty.items.length === 50, "N+1 proof expected fifty search items");

  assert(
    oneCounter.value === fiftyCounter.value,
    `Player360 search query count scaled with result count: one=${oneCounter.value}, fifty=${fiftyCounter.value}`,
  );
  assert(
    fiftyCounter.value <= 4,
    `Player360 search exceeded bounded query budget: ${fiftyCounter.value}`,
  );
}

async function provePoolSaturationAndBackpressure(): Promise<void> {
  const smallPool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 2_000,
  });
  try {
    const first = await smallPool.connect();
    const second = await smallPool.connect();
    assert(
      smallPool.totalCount === 2,
      `Pool created beyond configured max: ${smallPool.totalCount}`,
    );

    let thirdResolved = false;
    const thirdPromise = smallPool.connect().then((client) => {
      thirdResolved = true;
      return client;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    assert(!thirdResolved, "Pool did not apply backpressure while saturated");
    assert(
      smallPool.waitingCount === 1,
      `Expected one queued waiter, got ${smallPool.waitingCount}`,
    );
    assert(smallPool.totalCount === 2, `Backpressure escaped pool max: ${smallPool.totalCount}`);

    first.release();
    const third = await thirdPromise;
    assert(thirdResolved, "Queued request did not resume after capacity was released");
    third.release();
    second.release();

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert(
      smallPool.waitingCount === 0,
      `Pool waiter leaked after drain: ${smallPool.waitingCount}`,
    );
    assert(
      smallPool.totalCount <= 2,
      `Pool remained above configured max: ${smallPool.totalCount}`,
    );
  } finally {
    await smallPool.end();
  }
}

async function proveRealisticLoad(pool: Pool, playerIds: readonly string[]): Promise<void> {
  const repository = new PostgresPlayer360Repository(pool);
  const operations: Array<Promise<unknown>> = [];
  const startedAt = performance.now();

  for (let index = 0; index < 120; index += 1) {
    if (index % 3 === 0) {
      operations.push(repository.searchPlayers(SEARCH_QUERY));
    } else {
      const playerId = playerIds[index % playerIds.length];
      if (playerId === undefined) throw new Error("Missing load-test player fixture");
      operations.push(repository.getPlayer360(playerId, false));
    }
  }

  const results = await Promise.allSettled(operations);
  const failures = results.filter((result) => result.status === "rejected");
  assert(failures.length === 0, `Realistic mixed load had ${failures.length} rejected operations`);
  const elapsedMs = performance.now() - startedAt;
  const throughputPerSecond = operations.length / (elapsedMs / 1_000);
  assert(
    Number.isFinite(throughputPerSecond) && throughputPerSecond > 0,
    "Invalid measured throughput",
  );
  assert(pool.waitingCount === 0, `Main load pool did not drain: ${pool.waitingCount} waiters`);
  assert(pool.totalCount <= 8, `Main load pool exceeded configured max: ${pool.totalCount}`);

  process.stdout.write(
    `${JSON.stringify({ phase: "16.9", operations: operations.length, elapsedMs: Math.round(elapsedMs), throughputPerSecond: Number(throughputPerSecond.toFixed(2)) })}\n`,
  );
}

async function proveSoakAndMemory(pool: Pool): Promise<void> {
  const repository = new PostgresPlayer360Repository(pool);
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (gc === undefined) {
    throw new Error("Phase 16 soak proof requires Node --expose-gc");
  }

  gc();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const before = process.memoryUsage().heapUsed;

  for (let round = 0; round < 25; round += 1) {
    await Promise.all(Array.from({ length: 20 }, () => repository.searchPlayers(SEARCH_QUERY)));
    assert(
      pool.totalCount <= 8,
      `Soak pool exceeded max during round ${round}: ${pool.totalCount}`,
    );
  }

  gc();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = process.memoryUsage().heapUsed;
  const heapDelta = after - before;
  const allowedGrowth = 32 * 1024 * 1024;

  assert(heapDelta <= allowedGrowth, `Heap grew beyond soak budget: delta=${heapDelta}`);
  assert(pool.waitingCount === 0, `Soak left queued DB work: ${pool.waitingCount}`);
  assert(pool.totalCount <= 8, `Soak left pool above max: ${pool.totalCount}`);

  process.stdout.write(
    `${JSON.stringify({ phase: "16.14", operations: 500, heapDeltaBytes: heapDelta, allowedGrowthBytes: allowedGrowth })}\n`,
  );
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
  try {
    const playerIds = await seedPlayers(pool, 1_500);
    await proveExplainAnalyze(pool);
    await proveNoNPlusOne(pool);
    await provePoolSaturationAndBackpressure();
    await proveRealisticLoad(pool, playerIds);
    await proveSoakAndMemory(pool);

    process.stdout.write(
      "Phase 16 performance proof passed: realistic load, EXPLAIN ANALYZE/index usage, bounded Player360 query count, pool saturation/backpressure and soak/memory invariants.\n",
    );
  } finally {
    await pool.end();
  }
}

await main();
