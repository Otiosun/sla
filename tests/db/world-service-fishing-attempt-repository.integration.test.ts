import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresFishingAttemptRepository } from "../../src/platform/world-services/postgres-fishing-attempt-repository.js";
import { ManualClock, SystemClock } from "../../src/platform/clock/index.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
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
    repository = new PostgresFishingAttemptRepository(pool, {
      clock: new SystemClock(),
      fishingDayTimeZone: "Etc/UTC", // disposable proof uses explicit UTC, not production policy
    });

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

  it("deduplicates parallel deliveries of one fishing command at the PostgreSQL boundary", async () => {
    const playerId = await playerAt(fishingAreaId);
    const requests = Array.from({ length: 8 }, () =>
      repository.reserveAttempt({
        playerId,
        idempotencyKey: "fish-parallel-same-inbox",
        roll: 9,
      }),
    );
    const results = await Promise.all(requests);

    expect(results).toHaveLength(8);
    expect(results.every((item) => item.kind === "RESERVED")).toBe(true);
    expect(results.filter((item) => item.kind === "RESERVED" && !item.replayed)).toHaveLength(1);
    expect(results.filter((item) => item.kind === "RESERVED" && item.replayed)).toHaveLength(7);
    for (const item of results) {
      expect(item).toMatchObject({
        kind: "RESERVED",
        attemptNo: 1,
        remainingAttempts: 4,
        roll: 9,
      });
    }
    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM fishing_attempts WHERE player_id = $1",
      [playerId],
    );
    expect(persisted.rows[0]?.count).toBe("1");
  });

  it("enforces the five-attempt daily limit even with twelve different concurrent commands", async () => {
    const playerId = await playerAt(fishingAreaId);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.reserveAttempt({
          playerId,
          idempotencyKey: `fish-parallel-unique-${index}`,
          roll: 9,
        }),
      ),
    );

    const reserved = attempts.filter((item) => item.kind === "RESERVED");
    const limited = attempts.filter((item) => item.kind === "DAILY_LIMIT_REACHED");
    expect(reserved).toHaveLength(5);
    expect(limited).toHaveLength(7);
    expect(reserved.map((item) => item.kind === "RESERVED" ? item.attemptNo : -1).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5]);
    expect(limited.every((item) => item.kind === "DAILY_LIMIT_REACHED" && item.remainingAttempts === 0))
      .toBe(true);

    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM fishing_attempts WHERE player_id = $1",
      [playerId],
    );
    expect(persisted.rows[0]?.count).toBe("5");
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
  it("ROLLS BACK the daily cast when the published rarity table cannot create a canonical encounter", async () => {
    const playerId = await playerAt(fishingAreaId);
    const atomicRepo = new PostgresFishingAttemptRepository(pool, {
      seedProvider: new AesEncounterSeedProvider(
        Buffer.alloc(32, 0xa5), 1, () => Buffer.alloc(32, 0x4c),
      ),
      clock: new ManualClock(new Date("2026-09-08T12:00:00.000Z")),
      feature: {enabled:true, reason:null},
      fishingDayTimeZone: "Etc/UTC",
    });
    const failed=await atomicRepo.reserveAndResolve({
      playerId,idempotencyKey:"fish-rollback-invalid-published-table",roll:16,
    });
    expect(failed.ok).toBe(false);
    const empty=await pool.query<{count:string}>(
      "SELECT count(*)::text AS count FROM fishing_attempts WHERE player_id=$1",
      [playerId],
    );
    expect(empty.rows[0]?.count).toBe("0");
    expect((await pool.query<{count:string}>(
      "SELECT count(*)::text AS count FROM encounters WHERE player_id=$1",
      [playerId],
    )).rows[0]?.count).toBe("0");

    // The exact same user action is retryable after the failed transaction.
    // A new no-bite roll can be stored as attempt 1 rather than consuming 2.
    const later=await atomicRepo.reserveAndResolve({
      playerId,idempotencyKey:"fish-rollback-invalid-published-table",roll:9,
    });
    expect(later).toMatchObject({
      ok:true,value:{reservation:{kind:"RESERVED",attemptNo:1,roll:9},encounter:null},
    });
    expect((await pool.query<{count:string}>(
      "SELECT count(*)::text AS count FROM fishing_attempts WHERE player_id=$1",
      [playerId],
    )).rows[0]?.count).toBe("1");
  });

  it("atomically replays no-bite fishing without taking a sixth quota or new encounter", async () => {
    const playerId=await playerAt(fishingAreaId);
    const repo=new PostgresFishingAttemptRepository(pool, {
      seedProvider:new AesEncounterSeedProvider(Buffer.alloc(32,0xb1),1,()=>Buffer.alloc(32,0xb2)),
      clock:new ManualClock(new Date("2026-09-08T12:00:00.000Z")),
      feature:{enabled:true,reason:null},
      fishingDayTimeZone: "Etc/UTC",
    });
    const input={playerId,idempotencyKey:"fish-atomic-replay",roll:8};
    const results=await Promise.all(Array.from({length:6},()=>repo.reserveAndResolve(input)));
    expect(results.every(x=>x.ok)).toBe(true);
    expect(results.filter(x=>x.ok && x.value.reservation.kind==="RESERVED" &&
      !x.value.reservation.replayed)).toHaveLength(1);
    expect(results.filter(x=>x.ok && x.value.reservation.kind==="RESERVED" &&
      x.value.reservation.replayed)).toHaveLength(5);
    expect((await pool.query<{count:string}>(
      "SELECT count(*)::text AS count FROM fishing_attempts WHERE player_id=$1",
      [playerId],
    )).rows[0]?.count).toBe("1");
  });

  it("resets exactly at the configured calendar midnight, not the PostgreSQL UTC date", async () => {
    const playerId = await playerAt(fishingAreaId);
    const clock = new ManualClock(new Date("2026-10-31T02:59:59.000Z"));
    const zoned = new PostgresFishingAttemptRepository(pool, {
      clock,
      fishingDayTimeZone: "America/Recife", // proof fixture, NOT an approved world policy
    });
    const before = Array.from({length:5},(_,n)=>zoned.reserveAttempt({
      playerId, idempotencyKey:`boundary-${n}`, roll:9,
    }));
    const used = await Promise.all(before);
    expect(used.map(x=>x.kind==="RESERVED"?x.attemptNo:null).sort((a,b)=>(a??0)-(b??0)))
      .toEqual([1,2,3,4,5]);
    expect(await zoned.reserveAttempt({
      playerId,idempotencyKey:"boundary-sixth",roll:9,
    })).toMatchObject({kind:"DAILY_LIMIT_REACHED"});

    // Same message still replays its persisted outcome after the day changed.
    clock.advanceMs(1000);
    expect(await zoned.reserveAttempt({
      playerId,idempotencyKey:"boundary-0",roll:20,
    })).toMatchObject({kind:"RESERVED",replayed:true,attemptNo:1,roll:9});
    expect(await zoned.reserveAttempt({
      playerId,idempotencyKey:"boundary-new-day",roll:9,
    })).toMatchObject({kind:"RESERVED",replayed:false,attemptNo:1,remainingAttempts:4});
    const rows=await pool.query<{fishing_day:string;n:string}>(
      `SELECT fishing_day::text AS fishing_day,count(*)::text AS n
       FROM fishing_attempts WHERE player_id=$1 GROUP BY fishing_day ORDER BY fishing_day`,
      [playerId],
    );
    expect(rows.rows).toEqual([
      {fishing_day:"2026-10-30",n:"5"},
      {fishing_day:"2026-10-31",n:"1"},
    ]);
  });

});
