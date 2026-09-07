import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMartSaleInventoryReader } from "../../src/platform/world-services/postgres-mart-sale-inventory-reader.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

interface Fixture {
  readonly playerId: PlayerId;
  readonly potionId: string;
  readonly currencyId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const potionId = randomUUID();
  const repelId = randomUUID();
  const unconfiguredId = randomUUID();
  const currencyId = randomUUID();
  const playerId = createPlayerId();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `mart-sale-inventory-${rulesetId}`],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "8".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 43, 'mart-sale-inventory-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await client.query(
    `INSERT INTO items(id, slug) VALUES
       ($1, 'mart-sale-reader-potion'),
       ($2, 'mart-sale-reader-repel'),
       ($3, 'mart-sale-reader-unconfigured')`,
    [potionId, repelId, unconfiguredId],
  );
  for (const [itemId, displayName] of [
    [potionId, "Potion"],
    [repelId, "Repel"],
    [unconfiguredId, "Escape Rope"],
  ] as const) {
    await client.query(
      `INSERT INTO item_revisions(
         id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config
       ) VALUES ($1, $2, $3, $4, 'MEDICINE', 'mart-sale-reader', '{}'::jsonb)`,
      [randomUUID(), releaseId, itemId, displayName],
    );
  }
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'mart-sale-reader-pokedollar', 'PokéDollar', FALSE)`,
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_sale_offers(
       id, content_release_id, offer_key, item_id, currency_id, sale_amount, sort_order
     ) VALUES
       ($1, $3, 'shop.sell.potion', $4, $6, 125, 1),
       ($2, $3, 'shop.sell.repel', $5, $6, 80, 2)`,
    [randomUUID(), randomUUID(), releaseId, potionId, repelId, currencyId],
  );
  await client.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES
       ($1, $2, 3),
       ($1, $3, 0),
       ($1, $4, 5)`,
    [playerId, potionId, repelId, unconfiguredId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "9".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { playerId, potionId, currencyId };
}

describe("Poké Mart sellable inventory PostgreSQL read model", () => {
  const dbName = `pokemon_mart_sale_inventory_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "mart-sale-inventory-vitest" });
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

  it("returns only active configured sale offers that the player actually owns", async () => {
    const reader = new PostgresMartSaleInventoryReader(pool);

    const result = await reader.listSellableInventory(fixture.playerId);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          offerKey: "shop.sell.potion",
          itemId: fixture.potionId,
          displayName: "Potion",
          currencyId: fixture.currencyId,
          unitSaleAmount: 125n,
          inventoryQuantity: 3n,
        },
      ],
    });
  });
});
