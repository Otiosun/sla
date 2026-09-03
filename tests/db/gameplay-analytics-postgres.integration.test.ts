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

describe.sequential("PostgresGameplayAnalyticsRepository", () => {
  const dbName = `pokemon_gameplay_analytics_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-02T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;
  let rulesetId: string;
  let releaseId: string;
  let areaId: string;
  let formId: string;
  let ballItemId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "gameplay-analytics-proof" });

    rulesetId = randomUUID();
    releaseId = randomUUID();
    const regionId = randomUUID();
    areaId = randomUUID();
    const speciesId = randomUUID();
    formId = randomUUID();
    ballItemId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, 'f8-4-rules', 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 99991, 'F8.4 proof', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, 'f8-4-region')", [regionId]);
    await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, 'f8-4-area')", [
      areaId,
      regionId,
    ]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9991, 'f8-4-mon')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'base')", [
      formId,
      speciesId,
    ]);
    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-4-ball')", [ballItemId]);
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

  it("uses fixed half-open windows and suppresses each gameplay domain independently", async () => {
    const players = Array.from({ length: 6 }, () => randomUUID());
    for (const playerId of players) {
      await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    }

    const encounterStatuses = ["CAPTURED", "CAPTURED", "FLED", "EXPIRED", "CLOSED"] as const;
    const encounterIds: string[] = [];
    const createdTimes = [
      new Date("2026-09-01T12:00:00.000Z"),
      new Date("2026-09-02T01:00:00.000Z"),
      new Date("2026-09-02T02:00:00.000Z"),
      new Date("2026-09-02T03:00:00.000Z"),
      new Date("2026-09-02T04:00:00.000Z"),
    ];

    for (let index = 0; index < 5; index += 1) {
      const encounterId = randomUUID();
      encounterIds.push(encounterId);
      await pool.query(
        `INSERT INTO encounters(
          id, player_id, area_id, status, content_release_id, ruleset_id,
          rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
          created_at, updated_at, closed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$11)`,
        [
          encounterId,
          players[index],
          areaId,
          encounterStatuses[index],
          releaseId,
          rulesetId,
          Buffer.alloc(32, index + 1),
          Buffer.alloc(12, index + 1),
          Buffer.alloc(16, index + 1),
          createdTimes[index],
          new Date("2026-09-02T05:00:00.000Z"),
        ],
      );
    }

    const excludedEncounterId = randomUUID();
    await pool.query(
      `INSERT INTO encounters(
        id, player_id, area_id, status, content_release_id, ruleset_id,
        rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version,
        created_at, updated_at, closed_at
      ) VALUES ($1,$2,$3,'FLED',$4,$5,$6,$7,$8,1,$9,$9,$9)`,
      [
        excludedEncounterId,
        players[5],
        areaId,
        releaseId,
        rulesetId,
        Buffer.alloc(32, 9),
        Buffer.alloc(12, 9),
        Buffer.alloc(16, 9),
        asOf,
      ],
    );

    for (let index = 0; index < 5; index += 1) {
      const status = index < 2 ? "CAPTURED" : "FAILED";
      const resolvedAt =
        index === 4
          ? new Date("2026-08-31T12:00:00.000Z")
          : new Date(`2026-09-02T0${6 + index}:00:00.000Z`);
      let pokemonInstanceId: string | null = null;
      if (status === "CAPTURED") {
        pokemonInstanceId = randomUUID();
        await pool.query(
          `INSERT INTO pokemon_instances(
             id, owner_player_id, form_id, level, current_hp, status, origin_type,
             captured_at, created_at, updated_at
           ) VALUES ($1,$2,$3,5,20,'ACTIVE','CAPTURE',$4,$4,$4)`,
          [pokemonInstanceId, players[index], formId, resolvedAt],
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
          players[index],
          encounterIds[index],
          ballItemId,
          `f8-4-capture-${index}`,
          status,
          pokemonInstanceId,
          resolvedAt,
          `${index + 1}`.repeat(64).slice(0, 64),
          randomUUID(),
          Buffer.alloc(32, index + 1),
          Buffer.alloc(12, index + 1),
          Buffer.alloc(16, index + 1),
        ],
      );
    }

    const deltas = [100n, 50n, -20n, 30n, -10n];
    for (let index = 0; index < 5; index += 1) {
      await pool.query(
        `INSERT INTO trainer_progress_ledger(
           id, player_id, delta, source_type, source_id, actor_type,
           idempotency_scope, idempotency_key, created_at
         ) VALUES ($1,$2,$3,'F8_4_TEST',$4,'SYSTEM','f8.4',$5,$6)`,
        [
          randomUUID(),
          players[index],
          deltas[index]?.toString(),
          `progress-${index}`,
          `progress-${index}`,
          createdTimes[index],
        ],
      );
    }
    await pool.query(
      `INSERT INTO trainer_progress_ledger(
         id, player_id, delta, source_type, source_id, actor_type,
         idempotency_scope, idempotency_key, created_at
       ) VALUES ($1,$2,999,'F8_4_TEST','future','SYSTEM','f8.4','future',$3)`,
      [randomUUID(), players[5], new Date("2026-09-02T12:00:01.000Z")],
    );

    const result = await new PostgresGameplayAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );

    expect(result.windows).toEqual([
      {
        window: "24h",
        encounters: {
          suppressed: false,
          created: "5",
          closed: "5",
          captured: "2",
          fled: "1",
          expired: "1",
          closedOther: "1",
        },
        captures: { suppressed: true },
        trainerProgression: {
          suppressed: false,
          adjustments: "5",
          pointsAdded: "180",
          pointsRemoved: "30",
          netPoints: "150",
        },
      },
      {
        window: "7d",
        encounters: {
          suppressed: false,
          created: "5",
          closed: "5",
          captured: "2",
          fled: "1",
          expired: "1",
          closedOther: "1",
        },
        captures: {
          suppressed: false,
          resolved: "5",
          captured: "2",
          failed: "3",
        },
        trainerProgression: {
          suppressed: false,
          adjustments: "5",
          pointsAdded: "180",
          pointsRemoved: "30",
          netPoints: "150",
        },
      },
      {
        window: "30d",
        encounters: {
          suppressed: false,
          created: "5",
          closed: "5",
          captured: "2",
          fled: "1",
          expired: "1",
          closedOther: "1",
        },
        captures: {
          suppressed: false,
          resolved: "5",
          captured: "2",
          failed: "3",
        },
        trainerProgression: {
          suppressed: false,
          adjustments: "5",
          pointsAdded: "180",
          pointsRemoved: "30",
          netPoints: "150",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(players[0]);
  });
});
