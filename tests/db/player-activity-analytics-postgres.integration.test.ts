import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPlayerActivityAnalyticsRepository } from "../../src/platform/admin/postgres-player-activity-analytics-repository.js";
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

async function insertPlayer(pool: Pool, playerId: string, updatedAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO players(id, status, created_at, updated_at)
     VALUES ($1, 'ACTIVE', $2, $2)`,
    [playerId, updatedAt],
  );
}

async function insertProgressActivity(
  pool: Pool,
  playerId: string,
  occurredAt: Date,
  suffix: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO trainer_progress_ledger(
       id, player_id, delta, source_type, source_id, actor_type,
       idempotency_scope, idempotency_key, created_at
     ) VALUES ($1, $2, 1, 'F8_2_TEST', $3, 'SYSTEM', 'f8.2-test', $4, $5)`,
    [randomUUID(), playerId, `source-${suffix}`, `activity-${suffix}`, occurredAt],
  );
}

async function insertInventoryActivity(
  pool: Pool,
  playerId: string,
  itemId: string,
  occurredAt: Date,
  suffix: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO inventory_ledger(
       id, player_id, item_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     ) VALUES ($1, $2, $3, 1, 'F8_2_TEST', $4, $5, 'SYSTEM', 'f8.2-test', $6, $7, $8)`,
    [
      randomUUID(),
      playerId,
      itemId,
      `source-${suffix}`,
      `reason-${suffix}`,
      `inventory-${suffix}`,
      randomUUID(),
      occurredAt,
    ],
  );
}

async function insertWalletActivity(
  pool: Pool,
  playerId: string,
  currencyId: string,
  occurredAt: Date,
  suffix: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_ledger(
       id, player_id, currency_id, delta, source_type, source_id, reason, actor_type,
       idempotency_scope, idempotency_key, correlation_id, created_at
     ) VALUES ($1, $2, $3, 1, 'F8_2_TEST', $4, $5, 'SYSTEM', 'f8.2-test', $6, $7, $8)`,
    [
      randomUUID(),
      playerId,
      currencyId,
      `source-${suffix}`,
      `reason-${suffix}`,
      `wallet-${suffix}`,
      randomUUID(),
      occurredAt,
    ],
  );
}

async function insertPokemonActivity(
  pool: Pool,
  playerId: string,
  formId: string,
  occurredAt: Date,
  suffix: string,
): Promise<void> {
  const pokemonId = randomUUID();
  await pool.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, current_hp, origin_type
     ) VALUES ($1, $2, $3, 1, 10, 'F8_2_TEST')`,
    [pokemonId, playerId, formId],
  );
  await pool.query(
    `INSERT INTO pokemon_history_events(
       id, pokemon_instance_id, event_type, payload, actor_type, occurred_at
     ) VALUES ($1, $2, $3, '{}'::jsonb, 'SYSTEM', $4)`,
    [randomUUID(), pokemonId, `F8_2_TEST_${suffix}`, occurredAt],
  );
}

describe.sequential("PostgresPlayerActivityAnalyticsRepository", () => {
  const dbName = `pokemon_player_activity_${process.pid}_${Date.now()}`;
  const asOf = new Date("2026-09-01T12:00:00.000Z");
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "player-activity-analytics-proof" });
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

  it("counts fixed windows, distinct players, and prior-window returns", async () => {
    const player24h = randomUUID();
    const player7dDuplicate = randomUUID();
    const returningPlayer = randomUUID();
    const longLapsedPlayer = randomUUID();
    const player30dOnly = randomUUID();
    const playerOutside30d = randomUUID();
    const updatedAtOnlyPlayer = randomUUID();

    for (const playerId of [
      player24h,
      player7dDuplicate,
      returningPlayer,
      longLapsedPlayer,
      player30dOnly,
      playerOutside30d,
      updatedAtOnlyPlayer,
    ]) {
      await insertPlayer(pool, playerId, asOf);
    }

    await insertProgressActivity(pool, player24h, new Date("2026-09-01T00:00:00.000Z"), "24h");

    await insertProgressActivity(
      pool,
      player7dDuplicate,
      new Date("2026-08-30T12:00:00.000Z"),
      "7d-a",
    );
    await insertProgressActivity(
      pool,
      player7dDuplicate,
      new Date("2026-08-29T12:00:00.000Z"),
      "7d-b",
    );

    await insertProgressActivity(
      pool,
      returningPlayer,
      new Date("2026-08-29T12:00:00.000Z"),
      "return-current",
    );
    await insertProgressActivity(
      pool,
      returningPlayer,
      new Date("2026-08-22T12:00:00.000Z"),
      "return-prior",
    );

    await insertProgressActivity(
      pool,
      longLapsedPlayer,
      new Date("2026-08-31T12:00:00.000Z"),
      "lapsed-current",
    );
    await insertProgressActivity(
      pool,
      longLapsedPlayer,
      new Date("2026-08-12T12:00:00.000Z"),
      "lapsed-old",
    );

    await insertProgressActivity(pool, player30dOnly, new Date("2026-08-12T12:00:00.000Z"), "30d");
    await insertProgressActivity(
      pool,
      playerOutside30d,
      new Date("2026-08-01T11:59:59.999Z"),
      "outside",
    );

    // A fresh players.updated_at alone is deliberately not domain activity.
    await pool.query("UPDATE players SET updated_at = $2 WHERE id = $1", [
      updatedAtOnlyPlayer,
      asOf,
    ]);

    const repository = new PostgresPlayerActivityAnalyticsRepository(pool);
    await expect(repository.readAggregate("production", asOf)).resolves.toEqual({
      last24Hours: 2,
      last7Days: 4,
      last30Days: 5,
      returningPlayers7Days: 1,
    });
  });

  it("aggregates inventory, wallet, and Pokemon history without double-counting players", async () => {
    const secondAsOf = new Date("2026-10-15T12:00:00.000Z");
    const inventoryOnly = randomUUID();
    const walletReturning = randomUUID();
    const pokemonOnly = randomUUID();
    const crossLedger = randomUUID();
    const itemId = randomUUID();
    const currencyId = randomUUID();
    const speciesId = randomUUID();
    const formId = randomUUID();

    for (const playerId of [inventoryOnly, walletReturning, pokemonOnly, crossLedger]) {
      await insertPlayer(pool, playerId, secondAsOf);
    }

    await pool.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-2-analytics-item')", [itemId]);
    await pool.query(
      `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
       VALUES ($1, 'f8-2-analytics-currency', 'F8.2 Analytics Currency', FALSE)`,
      [currencyId],
    );
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 32000, 'f8-2-analytics-species')",
      [speciesId],
    );
    await pool.query(
      "INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'f8-2-analytics-form')",
      [formId, speciesId],
    );

    await insertInventoryActivity(
      pool,
      inventoryOnly,
      itemId,
      new Date("2026-10-15T00:00:00.000Z"),
      "inventory-only",
    );

    await insertWalletActivity(
      pool,
      walletReturning,
      currencyId,
      new Date("2026-10-10T12:00:00.000Z"),
      "wallet-current",
    );
    await insertWalletActivity(
      pool,
      walletReturning,
      currencyId,
      new Date("2026-10-05T12:00:00.000Z"),
      "wallet-prior",
    );

    await insertPokemonActivity(
      pool,
      pokemonOnly,
      formId,
      new Date("2026-09-20T12:00:00.000Z"),
      "pokemon-only",
    );

    await insertProgressActivity(
      pool,
      crossLedger,
      new Date("2026-10-14T12:00:00.000Z"),
      "cross-progress",
    );
    await insertInventoryActivity(
      pool,
      crossLedger,
      itemId,
      new Date("2026-10-14T00:00:00.000Z"),
      "cross-inventory",
    );
    await insertWalletActivity(
      pool,
      crossLedger,
      currencyId,
      new Date("2026-10-12T12:00:00.000Z"),
      "cross-wallet",
    );
    await insertPokemonActivity(
      pool,
      crossLedger,
      formId,
      new Date("2026-10-13T12:00:00.000Z"),
      "cross-pokemon",
    );

    const repository = new PostgresPlayerActivityAnalyticsRepository(pool);
    await expect(repository.readAggregate("production", secondAsOf)).resolves.toEqual({
      last24Hours: 2,
      last7Days: 3,
      last30Days: 4,
      returningPlayers7Days: 1,
    });
  });
});
