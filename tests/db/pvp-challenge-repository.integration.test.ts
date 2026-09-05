import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptPvpChallenge,
  createPvpChallenge,
  type PvpChallenge,
} from "../../src/modules/pvp/challenge.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PostgresPvpChallengeRepository } from "../../src/platform/pvp/postgres-pvp-challenge-repository.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

interface Fixture {
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const challengerPlayerId = randomUUID();
  const targetPlayerId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const rulesetId = randomUUID();
  const contentReleaseId = randomUUID();

  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    challengerPlayerId,
    targetPlayerId,
  ]);
  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `pvp-region-${regionId}`,
  ]);
  await pool.query(`INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)`, [
    areaId,
    regionId,
    `pvp-area-${areaId}`,
  ]);
  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `pvp-ruleset-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 28001, 'PVP challenge integration', 'DRAFT', $2)`,
    [contentReleaseId, rulesetId],
  );

  return {
    challengerPlayerId,
    targetPlayerId,
    areaId,
    contentReleaseId,
    rulesetId,
  };
}

async function fixtureWithFreshPlayers(pool: Pool, fixture: Fixture): Promise<Fixture> {
  const challengerPlayerId = randomUUID();
  const targetPlayerId = randomUUID();
  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    challengerPlayerId,
    targetPlayerId,
  ]);
  return { ...fixture, challengerPlayerId, targetPlayerId };
}

function createChallenge(fixture: Fixture, externalIdempotencyKey = "pvp-create-1"): PvpChallenge {
  const created = createPvpChallenge({
    id: randomUUID(),
    challengerPlayerId: fixture.challengerPlayerId,
    targetPlayerId: fixture.targetPlayerId,
    formatKey: "1V1",
    reachPolicy: "SAME_AREA",
    areaId: fixture.areaId,
    contentReleaseId: fixture.contentReleaseId,
    rulesetId: fixture.rulesetId,
    creationIdempotencyKey: externalIdempotencyKey,
    createdAt: new Date("2026-08-31T12:00:00.000Z"),
    expiresAt: new Date("2026-08-31T12:05:00.000Z"),
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

const seed = {
  ciphertext: new Uint8Array(32).fill(11),
  iv: new Uint8Array(12).fill(12),
  authTag: new Uint8Array(16).fill(13),
  keyVersion: 1,
} as const;

describe("PVP challenge PostgreSQL repository", () => {
  const dbName = `pokemon_pvp_challenge_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresPvpChallengeRepository;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "flow003-pvp-challenge-vitest" });
    repository = new PostgresPvpChallengeRepository(pool);
    fixture = await seedFixture(pool);
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

  it("persists one challenge identity and can replay it by creation key", async () => {
    const testFixture = await fixtureWithFreshPlayers(pool, fixture);
    const challenge = createChallenge(testFixture);

    const inserted = await repository.transaction((transaction) =>
      transaction.insertChallenge(challenge),
    );
    expect(inserted).toBe(true);

    const loaded = await repository.read((transaction) =>
      transaction.challengeByCreationKey(
        testFixture.challengerPlayerId,
        challenge.creationIdempotencyKey,
      ),
    );
    expect(loaded).toEqual(challenge);

    const duplicate = await repository.transaction((transaction) =>
      transaction.insertChallenge({ ...challenge, id: randomUUID() }),
    );
    expect(duplicate).toBe(false);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pvp_challenges
       WHERE challenger_player_id = $1 AND creation_idempotency_key = $2`,
      [testFixture.challengerPlayerId, challenge.creationIdempotencyKey],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("persists ACCEPTED challenge and its two PVP encounter participants atomically", async () => {
    const testFixture = await fixtureWithFreshPlayers(pool, fixture);
    const challenge = createChallenge(testFixture, "pvp-create-accept");
    const encounterId = randomUUID();
    const inserted = await repository.transaction((transaction) =>
      transaction.insertChallenge(challenge),
    );
    expect(inserted).toBe(true);

    const accepted = acceptPvpChallenge(challenge, {
      actorPlayerId: testFixture.targetPlayerId,
      encounterId,
      acceptedAt: new Date("2026-08-31T12:01:00.000Z"),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    await repository.transaction(async (transaction) => {
      const current = await transaction.challengeById(challenge.id, true);
      expect(current?.status).toBe("OPEN");
      await transaction.insertAcceptedEncounter({ challenge: accepted.value, seed });
      const replaced = await transaction.replaceChallenge({
        expectedRevision: challenge.revision,
        next: accepted.value,
      });
      expect(replaced).toBe(true);
    });

    const encounter = await pool.query<{
      mode: string;
      status: string;
      player_id: string;
    }>(`SELECT mode, status, player_id FROM encounters WHERE id = $1`, [encounterId]);
    expect(encounter.rows[0]).toEqual({
      mode: "PVP",
      status: "PRESENTED",
      player_id: testFixture.challengerPlayerId,
    });

    const participants = await pool.query<{
      player_id: string;
      side_no: number;
      role: string;
    }>(
      `SELECT player_id, side_no, role
       FROM encounter_players
       WHERE encounter_id = $1
       ORDER BY side_no`,
      [encounterId],
    );
    expect(participants.rows).toEqual([
      {
        player_id: testFixture.challengerPlayerId,
        side_no: 1,
        role: "CHALLENGER",
      },
      {
        player_id: testFixture.targetPlayerId,
        side_no: 2,
        role: "TARGET",
      },
    ]);

    const loaded = await repository.read((transaction) => transaction.challengeById(challenge.id));
    expect(loaded?.status).toBe("ACCEPTED");
    expect(loaded?.encounterId).toBe(encounterId);

    const parsedTarget = parsePlayerId(testFixture.targetPlayerId);
    expect(parsedTarget.ok).toBe(true);
    if (!parsedTarget.ok) return;
    const encounterRepository = new PostgresEncounterRepository(pool);
    const targetActiveEncounter = await encounterRepository.read((transaction) =>
      transaction.activeForPlayer(parsedTarget.value),
    );
    expect(targetActiveEncounter?.encounterId).toBe(encounterId);
  });

  it("rolls back encounter and challenge state when an acceptance transaction fails", async () => {
    const testFixture = await fixtureWithFreshPlayers(pool, fixture);
    const challenge = createChallenge(testFixture, "pvp-create-rollback");
    const encounterId = randomUUID();
    const inserted = await repository.transaction((transaction) =>
      transaction.insertChallenge(challenge),
    );
    expect(inserted).toBe(true);
    const accepted = acceptPvpChallenge(challenge, {
      actorPlayerId: testFixture.targetPlayerId,
      encounterId,
      acceptedAt: new Date("2026-08-31T12:01:30.000Z"),
    });
    if (!accepted.ok) throw new Error(accepted.error.message);

    await expect(
      repository.transaction(async (transaction) => {
        await transaction.insertAcceptedEncounter({ challenge: accepted.value, seed });
        const replaced = await transaction.replaceChallenge({
          expectedRevision: challenge.revision,
          next: accepted.value,
        });
        expect(replaced).toBe(true);
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    const encounterCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM encounters WHERE id = $1",
      [encounterId],
    );
    expect(encounterCount.rows[0]?.count).toBe("0");

    const loaded = await repository.read((transaction) => transaction.challengeById(challenge.id));
    expect(loaded?.status).toBe("OPEN");
    expect(loaded?.revision).toBe(0);
  });
});
