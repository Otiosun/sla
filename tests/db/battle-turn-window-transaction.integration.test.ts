import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateTurnWindowInput } from "../../src/modules/battle/turn-window.js";
import { openTurnWindowInTransaction } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
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

describe("transaction-local TurnWindow open", () => {
  const dbName = `pokemon_turn_window_tx_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let battleId: string;
  let playerA: string;
  let playerB: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "flow003-turn-window-tx-vitest" });

    const rulesetId = randomUUID();
    const releaseId = randomUUID();
    battleId = randomUUID();
    playerA = randomUUID();
    playerB = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId, `turn-window-tx-${rulesetId}`],
    );
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 27002, 'TurnWindow transaction integration', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')", [
      playerA,
      playerB,
    ]);
    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id,
         turn_number, version, rng_seed_ciphertext, rng_seed_iv,
         rng_seed_auth_tag, rng_seed_key_version, rng_counter
       ) VALUES ($1, 'PVP', 'ACTIVE', $2, $3, 0, 0, $4, $5, $6, 1, 0)`,
      [
        battleId,
        releaseId,
        rulesetId,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(16, 3),
      ],
    );
    await pool.query(
      `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
       VALUES ($1, 0, 1, '{}'::jsonb)`,
      [battleId],
    );
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

  it("opens and replays by battle/version inside the caller transaction", async () => {
    const input = (id: string): CreateTurnWindowInput => ({
      id,
      battleId,
      battleVersion: 0,
      turnNumber: 0,
      openedAt: new Date("2026-08-31T15:00:00.000Z"),
      deadlineAt: new Date("2026-08-31T15:05:00.000Z"),
      requiredPlayers: [
        { playerId: playerA, sideNo: 1 },
        { playerId: playerB, sideNo: 2 },
      ],
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const first = await openTurnWindowInTransaction(client, input(randomUUID()));
      const second = await openTurnWindowInTransaction(client, input(randomUUID()));

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(first.value.replayed).toBe(false);
      expect(second.value.replayed).toBe(true);
      expect(second.value.aggregate.window.id).toBe(first.value.aggregate.window.id);

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM battle_turn_windows
         WHERE battle_id = $1 AND battle_version = 0`,
        [battleId],
      );
      expect(count.rows[0]?.count).toBe("1");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
