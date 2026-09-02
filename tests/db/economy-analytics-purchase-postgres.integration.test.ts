import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PostgresEconomyAnalyticsRepository } from "../../src/platform/admin/postgres-economy-analytics-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

interface Fixture {
  readonly itemId: string;
  readonly currencyId: string;
}

function dbUrl(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function metadata(sourceId: string) {
  return {
    sourceType: "F8_3_PURCHASE_PROOF",
    sourceId,
    reason: `f8.3-purchase-proof:${sourceId}`,
    actorType: "SYSTEM" as const,
    actorId: null,
    correlationId: randomUUID(),
  };
}

async function createPlayer(client: PoolClient): Promise<PlayerId> {
  const playerId = createPlayerId();
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  return playerId;
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const itemId = randomUUID();
  const currencyId = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'f8-3-purchase-proof', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 901, 'f8-3-purchase-proof-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO items(id, slug) VALUES ($1, 'f8-3-purchase-proof-item')", [
    itemId,
  ]);
  await client.query(
    `INSERT INTO item_revisions(
       id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'F8.3 Purchase Proof Item', 'MEDICINE', 'heal-hp', '{"amount":20}'::jsonb)`,
    [randomUUID(), releaseId, itemId],
  );
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'f8-3-purchase-proof-currency', 'F8.3 Purchase Proof Currency', FALSE)`,
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_purchase_offers(
       id, content_release_id, offer_key, item_id, currency_id, item_quantity, price_amount, sort_order
     ) VALUES ($1, $2, 'f8-3.purchase-proof', $3, $4, 1, 200, 1)`,
    [randomUUID(), releaseId, itemId, currencyId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { itemId, currencyId };
}

describe.sequential("F8.3 economy analytics purchase reconciliation", () => {
  const dbName = `pokemon_f8_3_purchase_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;
  let economy: EconomyService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "f8-3-purchase-anomaly-proof" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
    economy = new EconomyService(new PostgresEconomyRepository(pool));
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

  it("does not classify a valid server-side purchase as a wallet or inventory projection anomaly", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    unwrap(
      await economy.creditWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 500n,
        idempotencyKey: "f8-3-purchase-wallet-seed",
        metadata: metadata("wallet-seed"),
      }),
    );
    const purchase = unwrap(
      await economy.purchase({
        playerId,
        offerKey: "f8-3.purchase-proof",
        idempotencyKey: "f8-3-valid-purchase",
        metadata: metadata("purchase"),
      }),
    );

    expect(purchase.walletAmount).toBe(300n);
    expect(purchase.inventoryQuantity).toBe(1n);

    const asOf = new Date(Date.now() + 60_000);
    const aggregate = await new PostgresEconomyAnalyticsRepository(pool).readAggregate(
      "production",
      asOf,
    );

    expect(aggregate.walletProjectionMismatches).toBe("0");
    expect(aggregate.inventoryProjectionMismatches).toBe("0");
  });
});
