import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementGrantInput } from "../../src/modules/entitlements/contracts.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEntitlementRepository } from "../../src/platform/entitlements/postgres-entitlement-repository.js";

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

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function systemGrant(
  playerId: string,
  overrides: Partial<EntitlementGrantInput> = {},
): EntitlementGrantInput {
  return {
    playerId,
    entitlementKey: "XP_2X",
    grantModel: "TIMED",
    durationSeconds: WEEK,
    sourceType: "ORDER",
    sourceId: "order-001",
    actorType: "SYSTEM",
    actorId: null,
    idempotencyScope: "premium-order",
    idempotencyKey: `grant:${randomUUID()}`,
    metadata: { sku: "2XP" },
    correlationId: null,
    ...overrides,
  };
}

describe.sequential("PostgresEntitlementRepository", () => {
  const dbName = `pokemon_entitlements_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresEntitlementRepository;
  let now = new Date("2026-10-16T12:00:00.000Z");
  let playerId: string;
  let secondPlayerId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "entitlements-vitest" });
    repository = new PostgresEntitlementRepository(pool, () => new Date(now));
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM entitlement_grants");
    await pool.query("DELETE FROM player_entitlements");
    await pool.query("DELETE FROM entitlement_definitions");
    await pool.query("DELETE FROM player_identities");
    await pool.query("DELETE FROM player_profiles");
    await pool.query("DELETE FROM onboarding_states");
    await pool.query("DELETE FROM trainer_progression");
    await pool.query("DELETE FROM players");

    now = new Date("2026-10-16T12:00:00.000Z");
    playerId = randomUUID();
    secondPlayerId = randomUUID();
    await pool.query(
      `INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`,
      [playerId, secondPlayerId],
    );
    await pool.query(
      `INSERT INTO entitlement_definitions(key, grant_model, active, metadata) VALUES
       ('XP_2X', 'TIMED', TRUE, '{"family":"XP"}'::jsonb),
       ('SAVE_PREMIUM', 'PERMANENT', TRUE, '{"family":"SAVE"}'::jsonb),
       ('LUCK_2X', 'TIMED', FALSE, '{"family":"LUCK"}'::jsonb)`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("grants a timed entitlement and materializes its current state atomically", async () => {
    const result = await repository.grant(
      systemGrant(playerId, { idempotencyKey: "order-001:XP_2X" }),
    );

    expect(result).toEqual({
      kind: "APPLIED",
      replayed: false,
      entitlement: {
        playerId,
        entitlementKey: "XP_2X",
        grantModel: "TIMED",
        administrativeStatus: "ACTIVE",
        startsAt: "2026-10-16T12:00:00.000Z",
        expiresAt: "2026-10-23T12:00:00.000Z",
        revision: "0",
        currentlyActive: true,
      },
    });

    const counts = await pool.query<{ state_count: string; grant_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM player_entitlements) AS state_count,
         (SELECT count(*)::text FROM entitlement_grants) AS grant_count`,
    );
    expect(counts.rows[0]).toEqual({ state_count: "1", grant_count: "1" });
  });

  it("replays the original result even after a later grant has advanced current state", async () => {
    const first = systemGrant(playerId, {
      sourceId: "order-first",
      idempotencyKey: "order-first:XP_2X",
    });
    const firstResult = await repository.grant(first);
    expect(firstResult.kind).toBe("APPLIED");

    now = new Date("2026-10-17T12:00:00.000Z");
    const secondResult = await repository.grant(
      systemGrant(playerId, {
        sourceId: "order-second",
        idempotencyKey: "order-second:XP_2X",
      }),
    );
    expect(secondResult).toMatchObject({
      kind: "APPLIED",
      replayed: false,
      entitlement: {
        revision: "1",
        startsAt: "2026-10-16T12:00:00.000Z",
        expiresAt: "2026-10-30T12:00:00.000Z",
      },
    });

    const replay = await repository.grant(first);
    expect(replay).toMatchObject({
      kind: "APPLIED",
      replayed: true,
      entitlement: {
        revision: "0",
        startsAt: "2026-10-16T12:00:00.000Z",
        expiresAt: "2026-10-23T12:00:00.000Z",
      },
    });

    const current = await repository.listPlayerEntitlements(playerId);
    expect(current[0]).toMatchObject({
      revision: "1",
      expiresAt: "2026-10-30T12:00:00.000Z",
    });
  });

  it("rejects reuse of an idempotency key with a different semantic request", async () => {
    const original = systemGrant(playerId, { idempotencyKey: "same-key" });
    expect((await repository.grant(original)).kind).toBe("APPLIED");

    const conflict = await repository.grant({
      ...original,
      durationSeconds: 2 * WEEK,
    });
    expect(conflict).toEqual({ kind: "IDEMPOTENCY_CONFLICT" });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM entitlement_grants",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("extends an active timed entitlement from its future expiry instead of from now", async () => {
    await repository.grant(
      systemGrant(playerId, { idempotencyKey: "extend-first", sourceId: "order-a" }),
    );
    now = new Date("2026-10-20T12:00:00.000Z");

    const result = await repository.grant(
      systemGrant(playerId, { idempotencyKey: "extend-second", sourceId: "order-b" }),
    );

    expect(result).toMatchObject({
      kind: "APPLIED",
      entitlement: {
        startsAt: "2026-10-16T12:00:00.000Z",
        expiresAt: "2026-10-30T12:00:00.000Z",
        revision: "1",
      },
    });
  });

  it("starts a new timed window from now after the previous entitlement expired", async () => {
    await repository.grant(
      systemGrant(playerId, { idempotencyKey: "expired-first", sourceId: "order-a" }),
    );
    now = new Date("2026-11-05T08:30:00.000Z");

    const result = await repository.grant(
      systemGrant(playerId, { idempotencyKey: "expired-second", sourceId: "order-b" }),
    );

    expect(result).toMatchObject({
      kind: "APPLIED",
      entitlement: {
        startsAt: "2026-11-05T08:30:00.000Z",
        expiresAt: "2026-11-12T08:30:00.000Z",
        revision: "1",
        currentlyActive: true,
      },
    });
  });

  it("reactivates a revoked timed entitlement from now rather than preserving revoked time", async () => {
    await repository.grant(
      systemGrant(playerId, { idempotencyKey: "revoked-first", sourceId: "order-a" }),
    );
    await pool.query(
      `UPDATE player_entitlements
       SET administrative_status = 'REVOKED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND entitlement_key = 'XP_2X'`,
      [playerId],
    );
    now = new Date("2026-10-18T09:00:00.000Z");

    const result = await repository.grant(
      systemGrant(playerId, { idempotencyKey: "revoked-second", sourceId: "order-b" }),
    );

    expect(result).toMatchObject({
      kind: "APPLIED",
      entitlement: {
        administrativeStatus: "ACTIVE",
        startsAt: "2026-10-18T09:00:00.000Z",
        expiresAt: "2026-10-25T09:00:00.000Z",
        revision: "2",
      },
    });
  });

  it("keeps a permanent entitlement permanent and records distinct grants without multiplying state", async () => {
    const first = systemGrant(playerId, {
      entitlementKey: "SAVE_PREMIUM",
      grantModel: "PERMANENT",
      durationSeconds: null,
      idempotencyKey: "save-first",
      sourceId: "order-save-a",
    });
    const firstResult = await repository.grant(first);
    expect(firstResult).toMatchObject({
      kind: "APPLIED",
      entitlement: { expiresAt: null, revision: "0" },
    });

    now = new Date("2026-10-21T12:00:00.000Z");
    const secondResult = await repository.grant({
      ...first,
      sourceId: "order-save-b",
      idempotencyKey: "save-second",
    });
    expect(secondResult).toMatchObject({
      kind: "APPLIED",
      entitlement: {
        startsAt: "2026-10-16T12:00:00.000Z",
        expiresAt: null,
        revision: "1",
      },
    });

    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM player_entitlements WHERE player_id = $1",
      [playerId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("serializes simultaneous duplicate grants into one ledger event plus one replay", async () => {
    const input = systemGrant(secondPlayerId, {
      idempotencyKey: "concurrent-duplicate",
      sourceId: "order-concurrent",
    });

    const [left, right] = await Promise.all([repository.grant(input), repository.grant(input)]);
    expect([left, right].filter((result) => result.kind === "APPLIED")).toHaveLength(2);
    expect(
      [left, right]
        .filter((result) => result.kind === "APPLIED")
        .map((result) => (result.kind === "APPLIED" ? result.replayed : null))
        .sort(),
    ).toEqual([false, true]);

    const counts = await pool.query<{ grants: string; revision: string }>(
      `SELECT
         (SELECT count(*)::text FROM entitlement_grants
          WHERE player_id = $1 AND entitlement_key = 'XP_2X') AS grants,
         (SELECT revision::text FROM player_entitlements
          WHERE player_id = $1 AND entitlement_key = 'XP_2X') AS revision`,
      [secondPlayerId],
    );
    expect(counts.rows[0]).toEqual({ grants: "1", revision: "0" });
  });

  it("refuses missing players, inactive definitions and grant-model mismatches without writing state", async () => {
    const missingPlayer = await repository.grant(systemGrant(randomUUID()));
    expect(missingPlayer).toEqual({ kind: "PLAYER_NOT_FOUND" });

    const inactive = await repository.grant(
      systemGrant(playerId, {
        entitlementKey: "LUCK_2X",
        idempotencyKey: "inactive-luck",
      }),
    );
    expect(inactive).toEqual({ kind: "DEFINITION_INACTIVE" });

    const mismatch = await repository.grant(
      systemGrant(playerId, {
        entitlementKey: "SAVE_PREMIUM",
        idempotencyKey: "mismatch-save",
      }),
    );
    expect(mismatch).toEqual({ kind: "GRANT_MODEL_MISMATCH" });

    const absentDefinition = await repository.grant(
      systemGrant(playerId, {
        entitlementKey: "DOES_NOT_EXIST",
        idempotencyKey: "missing-definition",
      }),
    );
    expect(absentDefinition).toEqual({ kind: "DEFINITION_NOT_FOUND" });

    const counts = await pool.query<{ state_count: string; grant_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM player_entitlements) AS state_count,
         (SELECT count(*)::text FROM entitlement_grants) AS grant_count`,
    );
    expect(counts.rows[0]).toEqual({ state_count: "0", grant_count: "0" });
  });
});
