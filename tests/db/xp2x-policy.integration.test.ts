import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";

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

describe.sequential("XP_2X battle multiplier policy", () => {
  const dbName = `pokemon_xp2x_policy_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrlFor("postgres"),
      max: 1,
    });

    await adminPool.query(`CREATE DATABASE "${dbName}"`);

    pool = new Pool({
      connectionString: databaseUrlFor(dbName),
      max: 4,
    });

    await runMigrations(pool, {
      appliedBy: "xp2x-policy-vitest",
    });
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

  it("is 2 only inside the active interval and 1 at the exact expiry boundary", async () => {
    const playerId = randomUUID();

    await pool.query(
      `INSERT INTO players(id, status)
       VALUES ($1, 'ACTIVE')`,
      [playerId],
    );

    await pool.query(
      `INSERT INTO player_entitlements(
         player_id,
         entitlement_key,
         grant_model,
         administrative_status,
         starts_at,
         expires_at,
         revision
       )
       VALUES(
         $1,
         'XP_2X',
         'TIMED',
         'ACTIVE',
         '2026-10-17T20:00:00Z',
         '2026-10-24T20:00:00Z',
         0
       )`,
      [playerId],
    );

    const multiplierAt = async (at: string) => {
      const result = await pool.query<{ multiplier: number }>(
        `SELECT pokemon_battle_xp_multiplier_for($1, $2)::int AS multiplier`,
        [playerId, at],
      );

      return result.rows[0]?.multiplier;
    };

    expect(await multiplierAt("2026-10-17T19:59:59.999Z")).toBe(1);
    expect(await multiplierAt("2026-10-17T20:00:00.000Z")).toBe(2);
    expect(await multiplierAt("2026-10-24T19:59:59.999Z")).toBe(2);
    expect(await multiplierAt("2026-10-24T20:00:00.000Z")).toBe(1);
    expect(await multiplierAt("2026-10-25T20:00:00.000Z")).toBe(1);

    await pool.query(
      `UPDATE player_entitlements
       SET administrative_status = 'REVOKED'
       WHERE player_id = $1
         AND entitlement_key = 'XP_2X'`,
      [playerId],
    );

    expect(await multiplierAt("2026-10-20T20:00:00.000Z")).toBe(1);
  });

  it("applies permanent Luck 2x to captures and respects revocation", async () => {
    const playerId = randomUUID();
    await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerId]);
    const check = async (at: string) => {
      const res = await pool.query<{ multiplier: number }>(
        `SELECT premium_capture_luck_multiplier_for($1, $2)::int AS multiplier`,
        [playerId, at],
      );
      return res.rows[0]?.multiplier;
    };
    expect(await check("2026-10-20T14:00:00Z")).toBe(1);
    await pool.query(
      `INSERT INTO player_entitlements(player_id, entitlement_key, grant_model,
          administrative_status, starts_at, expires_at, revision)
       VALUES($1, 'CAPTURE_LUCK_2X', 'PERMANENT', 'ACTIVE',
          '2026-10-20T14:00:00Z', NULL, 0)`,
      [playerId],
    );
    expect(await check("2026-10-20T13:59:59Z")).toBe(1);
    expect(await check("2026-10-20T14:00:00Z")).toBe(2);
    expect(await check("2027-10-20T14:00:00Z")).toBe(2);
    await pool.query(
      `UPDATE player_entitlements SET administrative_status = 'REVOKED'
       WHERE player_id = $1 AND entitlement_key = 'CAPTURE_LUCK_2X'`,
      [playerId],
    );
    expect(await check("2027-10-20T14:00:00Z")).toBe(1);
  });

  it("checks published entitlement SKU metadata for 2XP and LUCK", async () => {
    const res = await pool.query<{
      sku: string; fulfillment_kind: string; active: boolean; scope: string | null;
    }>(
      `SELECT sku, fulfillment_kind, active, metadata->>'scope' AS scope
       FROM premium_product_definitions WHERE sku IN ('2XP', 'LUCK') ORDER BY sku`,
    );
    expect(res.rows).toEqual([
      { sku: "2XP", fulfillment_kind: "ENTITLEMENT", active: true, scope: "ALL_EARNED_XP" },
      { sku: "LUCK", fulfillment_kind: "ENTITLEMENT", active: true, scope: "ALL_AUTHORIZED_CAPTURES" },
    ]);
  });
});
