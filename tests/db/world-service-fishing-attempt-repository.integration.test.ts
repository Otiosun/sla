import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresFishingAttemptRepository } from "../../src/platform/world-services/postgres-fishing-attempt-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function publishRuleset(client: PoolClient, rulesetId: string): Promise<void> {
  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'fishing-repository-proof', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
}

async function publishRelease(client: PoolClient, releaseId: string): Promise<void> {
  await client.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
}

describe.sequential("Fishing PostgreSQL attempt authority", () => {
  const dbName = `pokemon_fishing_repository_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresFishingAttemptRepository;
  let releaseId = "";
  let fishingAreaId = "";
  let dryAreaId = "";

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "fishing-repository-vitest" });
    repository = new PostgresFishingAttemptRepository(pool);

    const client = await pool.connect();
    try {
      const rulesetId = randomUUID();
      releaseId = randomUUID();
      const regionId = randomUUID();
      fishingAreaId = randomUUID();
      dryAreaId = randomUUID();

      await publishRuleset(client, rulesetId);
      await client.query("INSERT INTO regions(id, slug) VALUES ($1, 'zhoulia-fishing-proof')", [
        regionId,
      ]);
      await client.query(
        `INSERT INTO areas(id, region_id, slug) VALUES
           ($1, $3, 'rio-dos-arrozais'),
           ($2, $3, 'praca-seca')`,
        [fishingAreaId, dryAreaId, regionId],
      );
      await client.query(
        `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
         VALUES ($1, 999994, 'Fishing Repository Proof', 'DRAFT', $2)`,
        [releaseId, rulesetId],
      );
      await client.query(
        `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data)
         VALUES ($1, $2, $3, 'Zhoulia', TRUE, '{}'::jsonb)`,
        [randomUUID(), releaseId, regionId],
      );
      await client.query(
        `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
         VALUES
           ($1, $3, $4, 'Rio dos Arrozais', TRUE, $6::jsonb),
           ($2, $3, $5, 'Praça Seca', TRUE, $7::jsonb)`,
        [
          randomUUID(),
          randomUUID(),
          releaseId,
          fishingAreaId,
          dryAreaId,
          JSON.stringify({
            schemaVersion: 1,
            kind: "ROUTE",
            safePoint: false,
            startingArea: false,
            relocationPriority: 10,
            fishing: {
              pointName: "Rio dos Arrozais",
              encounterTables: {
                COMMON: "fishing-common",
                UNCOMMON: "fishing-uncommon",
              },
            },
          }),
          JSON.stringify({
            schemaVersion: 1,
            kind: "TOWN",
            safePoint: true,
            startingArea: false,
            relocationPriority: 20,
          }),
        ],
      );
      await publishRelease(client, releaseId);
      await client.query(
        "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
        [releaseId],
      );
    } finally {
      client.release();
    }
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

  async function playerAt(areaId: string): Promise<PlayerId> {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
       VALUES ($1, 'COMPLETE', 'fishing-proof-starter', now())`,
      [playerId],
    );
    await pool.query("INSERT INTO player_locations(player_id, area_id) VALUES ($1, $2)", [
      playerId,
      areaId,
    ]);
    return playerId;
  }

  it("persists configured rarity, table and daily counters", async () => {
    const playerId = await playerAt(fishingAreaId);

    const result = await repository.reserveAttempt({
      playerId,
      idempotencyKey: "fish-proof-01",
      roll: 16,
    });

    expect(result).toMatchObject({
      kind: "RESERVED",
      playerId,
      areaId: fishingAreaId,
      fishingPointName: "Rio dos Arrozais",
      attemptNo: 1,
      dailyLimit: 5,
      remainingAttempts: 4,
      roll: 16,
      rarity: "UNCOMMON",
      encounterTableSlug: "fishing-uncommon",
      replayed: false,
    });
  });

  it("replays the persisted attempt without changing the effective roll or consuming quota", async () => {
    const playerId = await playerAt(fishingAreaId);
    const first = await repository.reserveAttempt({
      playerId,
      idempotencyKey: "fish-replay-01",
      roll: 16,
    });
    const replay = await repository.reserveAttempt({
      playerId,
      idempotencyKey: "fish-replay-01",
      roll: 20,
    });

    expect(first).toMatchObject({ kind: "RESERVED", roll: 16, attemptNo: 1, replayed: false });
    expect(replay).toMatchObject({ kind: "RESERVED", roll: 16, attemptNo: 1, replayed: true });
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM fishing_attempts WHERE player_id = $1",
      [playerId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("allows exactly five attempts per day and refuses the sixth", async () => {
    const playerId = await playerAt(fishingAreaId);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reserved = await repository.reserveAttempt({
        playerId,
        idempotencyKey: `fish-limit-${attempt}`,
        roll: 9,
      });
      expect(reserved).toMatchObject({
        kind: "RESERVED",
        attemptNo: attempt,
        remainingAttempts: 5 - attempt,
      });
    }

    const sixth = await repository.reserveAttempt({
      playerId,
      idempotencyKey: "fish-limit-6",
      roll: 9,
    });
    expect(sixth).toEqual({
      kind: "DAILY_LIMIT_REACHED",
      playerId,
      dailyLimit: 5,
      remainingAttempts: 0,
    });
  });

  it("does not consume quota when the current area has no Fishing configuration", async () => {
    const playerId = await playerAt(dryAreaId);

    const result = await repository.reserveAttempt({
      playerId,
      idempotencyKey: "fish-dry-area",
      roll: 16,
    });

    expect(result).toMatchObject({
      kind: "FISHING_UNAVAILABLE",
      playerId,
    });
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM fishing_attempts WHERE player_id = $1",
      [playerId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("does not consume quota when a rolled encounter rarity has no configured ADM pool", async () => {
    for (const outcome of [
      { roll: 18, idempotencyKey: "fish-missing-rare" },
      { roll: 20, idempotencyKey: "fish-missing-extreme" },
    ] as const) {
      const playerId = await playerAt(fishingAreaId);

      const result = await repository.reserveAttempt({
        playerId,
        idempotencyKey: outcome.idempotencyKey,
        roll: outcome.roll,
      });

      expect(result).toMatchObject({
        kind: "FISHING_UNAVAILABLE",
        playerId,
      });
      const count = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM fishing_attempts WHERE player_id = $1",
        [playerId],
      );
      expect(count.rows[0]?.count).toBe("0");
    }
  });
});
