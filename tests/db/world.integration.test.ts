import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldService } from "../../src/modules/world/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

const VIRIDIAN_UNLOCK = "world.kanto.viridian-access";
const FEATURE_ENABLED = { enabled: true, reason: null } as const;

interface Fixture {
  readonly rulesetId: string;
  readonly releaseAId: string;
  readonly releaseBId: string;
  readonly regionId: string;
  readonly palletId: string;
  readonly route1Id: string;
  readonly viridianId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function publishRuleset(client: PoolClient, rulesetId: string): Promise<void> {
  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'phase7-world-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
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

async function createRelease(
  client: PoolClient,
  input: {
    readonly releaseId: string;
    readonly releaseNo: number;
    readonly name: string;
    readonly rulesetId: string;
    readonly parentReleaseId: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, parent_release_id, default_ruleset_id
     ) VALUES ($1, $2, $3, 'DRAFT', $4, $5)`,
    [input.releaseId, input.releaseNo, input.name, input.parentReleaseId, input.rulesetId],
  );
}

async function publishRelease(
  client: PoolClient,
  releaseId: string,
  fingerprint: string,
): Promise<void> {
  await client.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, fingerprint],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
}

async function insertAreaRevision(
  client: PoolClient,
  releaseId: string,
  areaId: string,
  displayName: string,
  config: {
    readonly schemaVersion: 1;
    readonly kind: "TOWN" | "CITY" | "ROUTE";
    readonly safePoint: boolean;
    readonly startingArea: boolean;
    readonly relocationPriority: number;
  },
  active = true,
): Promise<void> {
  await client.query(
    `INSERT INTO area_revisions(
       id, content_release_id, area_id, display_name, active, data
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), releaseId, areaId, displayName, active, JSON.stringify(config)],
  );
}

async function insertConnectionRevision(
  client: PoolClient,
  releaseId: string,
  connectionId: string,
  requiredUnlockKeys: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO area_connection_revisions(
       id, content_release_id, connection_id, access_rule, active
     ) VALUES ($1, $2, $3, $4::jsonb, TRUE)`,
    [
      randomUUID(),
      releaseId,
      connectionId,
      JSON.stringify({ schemaVersion: 1, requiredUnlockKeys }),
    ],
  );
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseAId = randomUUID();
  const releaseBId = randomUUID();
  const regionId = randomUUID();
  const palletId = randomUUID();
  const route1Id = randomUUID();
  const viridianId = randomUUID();

  await publishRuleset(client, rulesetId);
  await client.query("INSERT INTO regions(id, slug) VALUES ($1, 'kanto')", [regionId]);
  await client.query(
    `INSERT INTO areas(id, region_id, slug) VALUES
       ($1, $4, 'pallet-town'),
       ($2, $4, 'route-1'),
       ($3, $4, 'viridian-city')`,
    [palletId, route1Id, viridianId, regionId],
  );

  const connections = [
    { id: randomUUID(), from: palletId, to: route1Id, key: "north", unlocks: [] },
    { id: randomUUID(), from: route1Id, to: palletId, key: "south", unlocks: [] },
    {
      id: randomUUID(),
      from: route1Id,
      to: viridianId,
      key: "north",
      unlocks: [VIRIDIAN_UNLOCK],
    },
    { id: randomUUID(), from: viridianId, to: route1Id, key: "south", unlocks: [] },
  ] as const;
  for (const connection of connections) {
    await client.query(
      `INSERT INTO area_connections(id, from_area_id, to_area_id, connection_key)
       VALUES ($1, $2, $3, $4)`,
      [connection.id, connection.from, connection.to, connection.key],
    );
  }

  await createRelease(client, {
    releaseId: releaseAId,
    releaseNo: 1,
    name: "Phase 7 World Test A",
    rulesetId,
    parentReleaseId: null,
  });
  await client.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data)
     VALUES ($1, $2, $3, 'Kanto', TRUE, '{}'::jsonb)`,
    [randomUUID(), releaseAId, regionId],
  );
  await insertAreaRevision(client, releaseAId, palletId, "Pallet Town", {
    schemaVersion: 1,
    kind: "TOWN",
    safePoint: true,
    startingArea: true,
    relocationPriority: 0,
  });
  await insertAreaRevision(client, releaseAId, route1Id, "Route 1", {
    schemaVersion: 1,
    kind: "ROUTE",
    safePoint: false,
    startingArea: false,
    relocationPriority: 100,
  });
  await insertAreaRevision(client, releaseAId, viridianId, "Viridian City", {
    schemaVersion: 1,
    kind: "CITY",
    safePoint: true,
    startingArea: false,
    relocationPriority: 10,
  });
  for (const connection of connections) {
    await insertConnectionRevision(client, releaseAId, connection.id, connection.unlocks);
  }
  await publishRelease(client, releaseAId, "b".repeat(64));

  await createRelease(client, {
    releaseId: releaseBId,
    releaseNo: 2,
    name: "Phase 7 World Test B",
    rulesetId,
    parentReleaseId: releaseAId,
  });
  await client.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data)
     VALUES ($1, $2, $3, 'Kanto', TRUE, '{}'::jsonb)`,
    [randomUUID(), releaseBId, regionId],
  );
  await insertAreaRevision(client, releaseBId, palletId, "Pallet Town", {
    schemaVersion: 1,
    kind: "TOWN",
    safePoint: true,
    startingArea: true,
    relocationPriority: 0,
  });
  await insertAreaRevision(
    client,
    releaseBId,
    route1Id,
    "Route 1",
    {
      schemaVersion: 1,
      kind: "ROUTE",
      safePoint: false,
      startingArea: false,
      relocationPriority: 100,
    },
    false,
  );
  await insertAreaRevision(client, releaseBId, viridianId, "Viridian City", {
    schemaVersion: 1,
    kind: "CITY",
    safePoint: true,
    startingArea: false,
    relocationPriority: 10,
  });
  for (const connection of connections) {
    await insertConnectionRevision(client, releaseBId, connection.id, connection.unlocks);
  }
  await publishRelease(client, releaseBId, "c".repeat(64));

  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseAId],
  );
  return { rulesetId, releaseAId, releaseBId, regionId, palletId, route1Id, viridianId };
}

async function createEligiblePlayer(client: PoolClient, regionId: string): Promise<PlayerId> {
  const playerId = createPlayerId();
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await client.query(
    `INSERT INTO player_profiles(player_id, trainer_name, origin_region_id)
     VALUES ($1, 'World Tester', $2)`,
    [playerId, regionId],
  );
  await client.query(
    `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
     VALUES ($1, 'COMPLETE', 'phase7-world-test-starter', now())`,
    [playerId],
  );
  return playerId;
}

async function grantUnlock(client: PoolClient, playerId: PlayerId, key: string): Promise<void> {
  await client.query(
    `INSERT INTO trainer_unlocks(player_id, unlock_key, source_type, source_id)
     VALUES ($1, $2, 'TEST', 'phase7-world')`,
    [playerId, key],
  );
}

function service(pool: Pool): WorldService {
  return new WorldService(new PostgresWorldRepository(pool), FEATURE_ENABLED);
}

describe.sequential("Phase 7 world exploration on disposable PostgreSQL", () => {
  const dbName = `pokemon_phase7_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 16 });
    await runMigrations(pool, { appliedBy: "phase7-vitest" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
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

  it("persists initial location across retry/restart and navigates a gated cycle", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.regionId);
    client.release();

    const firstService = service(pool);
    const initial = unwrap(await firstService.ensureInitialLocation({ playerId }));
    expect(initial).toMatchObject({
      areaId: fixture.palletId,
      areaSlug: "pallet-town",
      revision: 0n,
      requiresRelocation: false,
    });
    const replay = unwrap(await firstService.ensureInitialLocation({ playerId }));
    expect(replay.areaId).toBe(fixture.palletId);
    expect(replay.revision).toBe(0n);

    const restartedService = service(pool);
    const afterRestart = unwrap(await restartedService.getLocation(playerId));
    expect(afterRestart.areaId).toBe(fixture.palletId);
    expect(afterRestart.revision).toBe(0n);

    const toRoute = unwrap(
      await restartedService.travel({
        playerId,
        destinationAreaId: fixture.route1Id,
        expectedRevision: 0n,
      }),
    );
    expect(toRoute.to.areaId).toBe(fixture.route1Id);
    expect(toRoute.to.revision).toBe(1n);

    const blockedByRequirement = await restartedService.travel({
      playerId,
      destinationAreaId: fixture.viridianId,
      expectedRevision: 1n,
    });
    expect(blockedByRequirement).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(unwrap(await restartedService.getLocation(playerId)).revision).toBe(1n);

    const unlockClient = await pool.connect();
    await grantUnlock(unlockClient, playerId, VIRIDIAN_UNLOCK);
    unlockClient.release();

    const toViridian = unwrap(
      await restartedService.travel({
        playerId,
        destinationAreaId: fixture.viridianId,
        expectedRevision: 1n,
      }),
    );
    expect(toViridian.to.areaId).toBe(fixture.viridianId);
    expect(toViridian.to.revision).toBe(2n);

    const backToRoute = unwrap(
      await restartedService.travel({
        playerId,
        destinationAreaId: fixture.route1Id,
        expectedRevision: 2n,
      }),
    );
    const backToPallet = unwrap(
      await restartedService.travel({
        playerId,
        destinationAreaId: fixture.palletId,
        expectedRevision: backToRoute.to.revision,
      }),
    );
    expect(backToPallet.to.areaId).toBe(fixture.palletId);
    expect(backToPallet.to.revision).toBe(4n);
  });

  it("allows exactly one concurrent move for the same expected revision", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.regionId);
    client.release();
    const world = service(pool);
    unwrap(await world.ensureInitialLocation({ playerId }));

    const attempts = await Promise.all([
      world.travel({ playerId, destinationAreaId: fixture.route1Id, expectedRevision: 0n }),
      world.travel({ playerId, destinationAreaId: fixture.route1Id, expectedRevision: 0n }),
    ]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(
      attempts.filter((result) => !result.ok && result.error.code === "REVISION_CONFLICT"),
    ).toHaveLength(1);

    const stale = await world.travel({
      playerId,
      destinationAreaId: fixture.palletId,
      expectedRevision: 0n,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(unwrap(await world.getLocation(playerId)).revision).toBe(1n);
  });

  it("blocks travel for missing paths and persisted encounter/battle flows", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.regionId);
    client.release();
    const world = service(pool);
    unwrap(await world.ensureInitialLocation({ playerId }));

    const noDirectPath = await world.travel({
      playerId,
      destinationAreaId: fixture.viridianId,
      expectedRevision: 0n,
    });
    expect(noDirectPath).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });

    const flowClient = await pool.connect();
    const encounterId = randomUUID();
    await flowClient.query(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
       ) VALUES ($1, $2, $3, 'PRESENTED', $4, $5, $6, $7, $8, 1)`,
      [
        encounterId,
        playerId,
        fixture.palletId,
        fixture.releaseAId,
        fixture.rulesetId,
        Buffer.alloc(32),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    );
    flowClient.release();

    const encounterBlocked = await world.travel({
      playerId,
      destinationAreaId: fixture.route1Id,
      expectedRevision: 0n,
    });
    expect(encounterBlocked).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });

    const battleClient = await pool.connect();
    await battleClient.query(
      "UPDATE encounters SET status = 'CLOSED', closed_at = now() WHERE id = $1",
      [encounterId],
    );
    const battleId = randomUUID();
    await battleClient.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
       ) VALUES ($1, 'TEST', 'ACTIVE', $2, $3, $4, $5, $6, 1)`,
      [
        battleId,
        fixture.releaseAId,
        fixture.rulesetId,
        Buffer.alloc(32),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    );
    await battleClient.query(
      `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
       VALUES ($1, $2, 1, 'PLAYER', $3)`,
      [randomUUID(), battleId, playerId],
    );
    battleClient.release();

    const battleBlocked = await world.travel({
      playerId,
      destinationAreaId: fixture.route1Id,
      expectedRevision: 0n,
    });
    expect(battleBlocked).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("preserves historical area revisions and relocates safely after release switch", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.regionId);
    client.release();
    const world = service(pool);
    unwrap(await world.ensureInitialLocation({ playerId }));
    const route = unwrap(
      await world.travel({
        playerId,
        destinationAreaId: fixture.route1Id,
        expectedRevision: 0n,
      }),
    );
    expect(route.to.revision).toBe(1n);

    await pool.query(
      `UPDATE content_release_pointers
       SET content_release_id = $1, revision = revision + 1, updated_at = now()
       WHERE pointer_key = 'ACTIVE'`,
      [fixture.releaseBId],
    );

    const view = unwrap(await service(pool).getLocation(playerId));
    expect(view).toMatchObject({
      areaId: fixture.route1Id,
      requiresRelocation: true,
      relocationAreaId: fixture.palletId,
      revision: 1n,
    });

    const travelWhileInactive = await service(pool).travel({
      playerId,
      destinationAreaId: fixture.palletId,
      expectedRevision: 1n,
    });
    expect(travelWhileInactive).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        details: { requiresRelocation: true, relocationAreaId: fixture.palletId },
      },
    });

    const relocated = unwrap(await service(pool).relocate({ playerId, expectedRevision: 1n }));
    expect(relocated).toMatchObject({
      areaId: fixture.palletId,
      requiresRelocation: false,
      revision: 2n,
    });

    const history = await pool.query<{ release_id: string; active: boolean }>(
      `SELECT content_release_id AS release_id, active
       FROM area_revisions
       WHERE area_id = $1 AND content_release_id IN ($2, $3)
       ORDER BY content_release_id`,
      [fixture.route1Id, fixture.releaseAId, fixture.releaseBId],
    );
    expect(history.rows).toEqual(
      expect.arrayContaining([
        { release_id: fixture.releaseAId, active: true },
        { release_id: fixture.releaseBId, active: false },
      ]),
    );
  });
});
