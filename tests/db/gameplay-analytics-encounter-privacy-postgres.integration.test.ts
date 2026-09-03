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

describe.sequential("F8.4 encounter cohort privacy", () => {
  const dbName = `pokemon_gameplay_privacy_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-02T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;
  let releaseId: string;
  let rulesetId: string;
  let areaId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "gameplay-analytics-privacy-proof" });

    rulesetId = randomUUID();
    releaseId = randomUUID();
    const regionId = randomUUID();
    areaId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status, published_at)
       VALUES ($1, $2, 1, 1, '{}'::jsonb, 'PUBLISHED', $3)`,
      [rulesetId, `f8-4-privacy-${rulesetId}`, new Date("2026-08-01T00:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id, published_at)
       VALUES ($1, 99992, 'F8.4 privacy proof', 'PUBLISHED', $2, $3)`,
      [releaseId, rulesetId, new Date("2026-08-01T00:00:00.000Z")],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
      regionId,
      `f8-4-privacy-region-${regionId}`,
    ]);
    await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
      areaId,
      regionId,
      `f8-4-privacy-area-${areaId}`,
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

  it("does not let five encounter creators lend anonymity to one closer", async () => {
    const players = Array.from({ length: 5 }, () => randomUUID());
    for (const playerId of players) {
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    }

    for (let index = 0; index < players.length; index += 1) {
      const playerId = players[index];
      const closed = index === 0;
      await pool.query(
        `INSERT INTO encounters(
           id, player_id, area_id, status, content_release_id, ruleset_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
           created_at, updated_at, closed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12)`,
        [
          randomUUID(),
          playerId,
          areaId,
          closed ? "FLED" : "ACTIVE",
          releaseId,
          rulesetId,
          Buffer.alloc(32, index + 1),
          Buffer.alloc(12, index + 1),
          Buffer.alloc(16, index + 1),
          new Date(`2026-09-02T0${index + 1}:00:00.000Z`),
          new Date("2026-09-02T06:00:00.000Z"),
          closed ? new Date("2026-09-02T06:00:00.000Z") : null,
        ],
      );
    }

    const result = await new PostgresGameplayAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );
    const encounter = result.windows.find((window) => window.window === "24h")?.encounters;

    expect(encounter).toEqual({
      created: { suppressed: false, count: "5" },
      closures: { suppressed: true },
    });
  });
});
