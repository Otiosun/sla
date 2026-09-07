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

interface SellQuantityInput {
  readonly playerId: PlayerId;
  readonly offerKey: string;
  readonly quantity: bigint;
  readonly idempotencyKey: string;
  readonly metadata: ReturnType<typeof metadata>;
}

interface SaleResult {
  readonly playerId: PlayerId;
  readonly contentReleaseId: string;
  readonly offerKey: string;
  readonly saleQuantity: bigint;
  readonly itemId: string;
  readonly inventoryQuantity: bigint;
  readonly currencyId: string;
  readonly saleAmount: bigint;
  readonly walletAmount: bigint;
  readonly replayed: boolean;
}

type SaleCapableEconomyService = EconomyService & {
  sellQuantity(
    input: SellQuantityInput,
  ): Promise<
    | { readonly ok: true; readonly value: SaleResult }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >;
};

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function metadata(sourceId: string) {
  return {
    sourceType: "TEST",
    sourceId,
    reason: `quantity-sale:${sourceId}`,
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
     VALUES ($1, 'quantity-sale-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "b".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 42, 'quantity-sale-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO items(id, slug) VALUES ($1, 'quantity-sale-potion')", [itemId]);
  await client.query(
    `INSERT INTO item_revisions(
       id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'Quantity Sale Potion', 'MEDICINE', 'heal-hp', '{"amount":20}'::jsonb)`,
    [randomUUID(), releaseId, itemId],
  );
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'quantity-sale-pokedollar', 'Quantity Sale PokéDollar', FALSE)`,
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_sale_offers(
       id, content_release_id, offer_key, item_id, currency_id, sale_amount, sort_order
     ) VALUES ($1, $2, 'shop.sell.quantity-potion', $3, $4, 125, 1)`,
    [randomUUID(), releaseId, itemId, currencyId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "c".repeat(64)],
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

async function seedInventory(
  service: EconomyService,
  playerId: PlayerId,
  itemId: string,
  quantity: bigint,
  key: string,
): Promise<void> {
  const added = await service.addItem({
    playerId,
    itemId,
    quantity,
    idempotencyKey: `${key}:inventory-seed`,
    metadata: metadata(`${key}:inventory-seed`),
  });
  if (!added.ok) throw new Error(`${added.error.code}: ${added.error.message}`);
}

function saleService(service: EconomyService): SaleCapableEconomyService {
  return service as SaleCapableEconomyService;
}

describe.sequential("atomic economy quantity sales", () => {
  const dbName = `pokemon_quantity_sale_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;
  let service: EconomyService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "quantity-sale-vitest" });
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

  it("consumes the requested item quantity and credits the configured sale value atomically", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedInventory(service, playerId, fixture.itemId, 8n, "multiply");

    const sale = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-sale-multiply",
      metadata: metadata("quantity-sale-multiply"),
    });

    expect(sale).toMatchObject({
      ok: true,
      value: {
        contentReleaseId: fixture.releaseId,
        offerKey: "shop.sell.quantity-potion",
        saleQuantity: 3n,
        itemId: fixture.itemId,
        inventoryQuantity: 5n,
        currencyId: fixture.currencyId,
        saleAmount: 375n,
        walletAmount: 375n,
        replayed: false,
      },
    });
  });

  it("rolls back claims and wallet credit when inventory is insufficient", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedInventory(service, playerId, fixture.itemId, 2n, "insufficient");

    const sale = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-sale-insufficient",
      metadata: metadata("quantity-sale-insufficient"),
    });

    expect(sale).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 2n,
    });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 0n,
    });
    const ledgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger
          WHERE player_id = $1 AND source_type = 'SALE_OFFER')::text AS inventory,
         (SELECT count(*) FROM wallet_ledger
          WHERE player_id = $1 AND source_type = 'SALE_OFFER')::text AS wallet`,
      [playerId],
    );
    expect(ledgers.rows[0]).toEqual({ inventory: "0", wallet: "0" });
  });

  it("replays the same sale without consuming or crediting twice", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedInventory(service, playerId, fixture.itemId, 8n, "replay");
    const saleMetadata = metadata("quantity-sale-replay");

    const first = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-sale-replay",
      metadata: saleMetadata,
    });
    const replay = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-sale-replay",
      metadata: { ...saleMetadata, correlationId: randomUUID() },
    });

    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        saleQuantity: 2n,
        inventoryQuantity: 6n,
        saleAmount: 250n,
        walletAmount: 250n,
        replayed: true,
      },
    });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 6n,
    });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 250n,
    });
  });

  it("rejects reuse of a sale fingerprint for a different quantity", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedInventory(service, playerId, fixture.itemId, 8n, "mismatch");
    const saleMetadata = metadata("quantity-sale-mismatch");

    const first = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 2n,
      idempotencyKey: "quantity-sale-mismatch",
      metadata: saleMetadata,
    });
    expect(first).toMatchObject({ ok: true });

    const mismatch = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 3n,
      idempotencyKey: "quantity-sale-mismatch",
      metadata: { ...saleMetadata, correlationId: randomUUID() },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    await expect(service.getInventoryBalance(playerId, fixture.itemId)).resolves.toEqual({
      ok: true,
      value: 6n,
    });
    await expect(service.getWalletBalance(playerId, fixture.currencyId)).resolves.toEqual({
      ok: true,
      value: 250n,
    });
  });

  it("rejects multiplied BIGINT overflow before creating sale ledgers", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();
    await seedInventory(service, playerId, fixture.itemId, 1n, "overflow");

    const overflow = await saleService(service).sellQuantity({
      playerId,
      offerKey: "shop.sell.quantity-potion",
      quantity: 9_223_372_036_854_775_807n,
      idempotencyKey: "quantity-sale-overflow",
      metadata: metadata("quantity-sale-overflow"),
    });

    expect(overflow).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const ledgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger
          WHERE player_id = $1 AND source_type = 'SALE_OFFER')::text AS inventory,
         (SELECT count(*) FROM wallet_ledger
          WHERE player_id = $1 AND source_type = 'SALE_OFFER')::text AS wallet`,
      [playerId],
    );
    expect(ledgers.rows[0]).toEqual({ inventory: "0", wallet: "0" });
  });
});
