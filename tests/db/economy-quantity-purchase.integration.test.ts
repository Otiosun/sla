import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EconomyService } from "../../src/modules/economy/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

interface Fixture {
  readonly releaseId: string;
  readonly itemId: string;
  readonly currencyId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function metadata(sourceId: string) {
  return {
    sourceType: "TEST",
    sourceId,
    reason: `quantity-purchase:${sourceId}`,
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
     VALUES ($1, 'quantity-purchase-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "d".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 41, 'quantity-purchase-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO items(id, slug) VALUES ($1, 'quantity-potion')", [itemId]);
  await client.query(
    `INSERT INTO item_revisions(
       id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'Quantity Potion', 'MEDICINE', 'heal-hp', '{"amount":20}'::jsonb)`,
    [randomUUID(), releaseId, itemId],
  );
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'quantity-pokedollar', 'Quantity PokéDollar', FALSE)`,
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_purchase_offers(
       id, content_release_id, offer_key, item_id, currency_id, item_quantity, price_amount, sort_order
     ) VALUES ($1, $2, 'shop.quantity-potion', $3, $4, 2, 200, 1)`,
    [randomUUID(), releaseId, itemId, currencyId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "e".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    "INSERT INTO content_release_pointers(pointer_key, content_release_id) VALUES ('ACTIVE', $1)",
    [releaseId],
  );

  return { releaseId, itemId, currencyId };
}

async function seedWallet(
  service: EconomyService,
  playerId: PlayerId,
  currencyId: string,
  amount: bigint,
  key: string,
): Promise<void> {
  const credited = await service.creditWallet({
    playerId,
    currencyId,
    amount,
    idempotencyKey: `${key}:wallet-seed`,
    metadata: metadata(`${key}:wallet-seed`),
  });
  if (!credited.ok) throw new Error(`${credited.error.code}: ${credited.error.message}`);
}

describe.sequential("atomic economy quantity purchases", () => {
  const dbName = `pokemon_quantity_purchase_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;
  let service: EconomyService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "quantity-purchase-vitest" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
    service = new EconomyService(new PostgresEconomyRepository(pool));
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

  it("multiplies server-side item quantity and price atomically", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedWallet(service, playerId, fixture.currencyId, 1_000n, "multiply");

    const purchase = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-multiply",
      metadata: metadata("quantity-multiply"),
    });

    expect(purchase).toMatchObject({
      ok: true,
      value: {
        purchaseQuantity: 3n,
        itemQuantity: 6n,
        priceAmount: 600n,
        inventoryQuantity: 6n,
        walletAmount: 400n,
        replayed: false,
      },
    });
  });

  it("rolls back claims and inventory when the multiplied price exceeds the wallet", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedWallet(service, playerId, fixture.currencyId, 500n, "insufficient");

    const purchase = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-insufficient",
      metadata: metadata("quantity-insufficient"),
    });

    expect(purchase).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 500n,
    });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 0n,
    });
    const ledgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger
          WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS inventory,
         (SELECT count(*) FROM wallet_ledger
          WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS wallet`,
      [playerId],
    );
    expect(ledgers.rows[0]).toEqual({ inventory: "0", wallet: "0" });
  });

  it("replays the same quantity purchase without charging or crediting twice", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedWallet(service, playerId, fixture.currencyId, 1_000n, "replay");
    const purchaseMetadata = metadata("quantity-replay");

    const first = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-replay",
      metadata: purchaseMetadata,
    });
    const replay = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-replay",
      metadata: { ...purchaseMetadata, correlationId: randomUUID() },
    });

    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        purchaseQuantity: 2n,
        itemQuantity: 4n,
        priceAmount: 400n,
        inventoryQuantity: 4n,
        walletAmount: 600n,
        replayed: true,
      },
    });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 600n,
    });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 4n,
    });
  });

  it("rejects reuse of a quantity-purchase fingerprint for a different quantity", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedWallet(service, playerId, fixture.currencyId, 2_000n, "mismatch");
    const purchaseMetadata = metadata("quantity-mismatch");

    const first = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-mismatch",
      metadata: purchaseMetadata,
    });
    expect(first).toMatchObject({ ok: true });

    const mismatch = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-mismatch",
      metadata: { ...purchaseMetadata, correlationId: randomUUID() },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 1_600n,
    });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 4n,
    });
  });

  it("rejects multiplied BIGINT overflow before creating purchase ledgers", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedWallet(service, playerId, fixture.currencyId, 1_000n, "overflow");

    const overflow = await service.purchaseQuantity({
      playerId,
      offerKey: "shop.quantity-potion",
      quantity: 9_223_372_036_854_775_807n,
      idempotencyKey: "quantity-overflow",
      metadata: metadata("quantity-overflow"),
    });

    expect(overflow).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const ledgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger
          WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS inventory,
         (SELECT count(*) FROM wallet_ledger
          WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS wallet`,
      [playerId],
    );
    expect(ledgers.rows[0]).toEqual({ inventory: "0", wallet: "0" });
  });
});
