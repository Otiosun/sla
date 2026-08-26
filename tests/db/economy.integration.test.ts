import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EconomyService } from "../../src/modules/economy/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

interface Fixture {
  readonly releaseId: string;
  readonly itemId: string;
  readonly currencyId: string;
  readonly offerId: string;
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

function metadata(sourceId: string) {
  return {
    sourceType: "TEST",
    sourceId,
    reason: `economy-test:${sourceId}`,
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
  const offerId = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'phase6-economy-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now(),
       validation_report = '{"valid":true,"issues":[]}'::jsonb, config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
  );
  await client.query("UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [
    rulesetId,
  ]);
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 1, 'phase6-economy-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO items(id, slug) VALUES ($1, 'phase6-potion')", [itemId]);
  await client.query(
    `INSERT INTO item_revisions(
       id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config
     ) VALUES ($1, $2, $3, 'Phase 6 Potion', 'MEDICINE', 'heal-hp', '{"amount":20}'::jsonb)`,
    [randomUUID(), releaseId, itemId],
  );
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, 'pokedollar', 'PokéDollar', FALSE)`,
    [currencyId],
  );
  await client.query(
    `INSERT INTO item_purchase_offers(
       id, content_release_id, offer_key, item_id, currency_id, item_quantity, price_amount, sort_order
     ) VALUES ($1, $2, 'shop.phase6-potion', $3, $4, 1, 200, 1)`,
    [offerId, releaseId, itemId, currencyId],
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
  return { releaseId, itemId, currencyId, offerId };
}

describe.sequential("Phase 6 economy on disposable PostgreSQL", () => {
  const dbName = `pokemon_phase6_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;
  let service: EconomyService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 16 });
    await runMigrations(pool, { appliedBy: "phase6-vitest" });
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

  it("applies grants once and rejects semantic reuse of the same idempotency key", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    const first = unwrap(
      await service.addItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 2n,
        idempotencyKey: "grant-item-a",
        metadata: metadata("grant-a"),
      }),
    );
    expect(first.replayed).toBe(false);
    expect(first.quantity).toBe(2n);

    const replayMetadata = metadata("grant-a");
    replayMetadata.correlationId = randomUUID();
    const replay = unwrap(
      await service.addItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 2n,
        idempotencyKey: "grant-item-a",
        metadata: replayMetadata,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.ledgerId).toBe(first.ledgerId);
    expect(replay.quantity).toBe(2n);

    const mismatch = await service.addItem({
      playerId,
      itemId: fixture.itemId,
      quantity: 3n,
      idempotencyKey: "grant-item-a",
      metadata: replayMetadata,
    });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_INVALID" } });

    const ledger = await pool.query<{ count: string; missing_audit: string }>(
      `SELECT count(*)::text AS count,
              count(*) FILTER (WHERE reason IS NULL OR correlation_id IS NULL)::text AS missing_audit
       FROM inventory_ledger WHERE player_id = $1`,
      [playerId],
    );
    expect(ledger.rows[0]).toEqual({ count: "1", missing_audit: "0" });
  });

  it("allows only one concurrent spend of the last item and the last wallet balance", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    unwrap(
      await service.addItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 1n,
        idempotencyKey: "last-item-seed",
        metadata: metadata("last-item-seed"),
      }),
    );
    const itemAttempts = await Promise.all([
      service.consumeItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 1n,
        idempotencyKey: "last-item-a",
        metadata: metadata("last-item-a"),
      }),
      service.consumeItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 1n,
        idempotencyKey: "last-item-b",
        metadata: metadata("last-item-b"),
      }),
    ]);
    expect(itemAttempts.filter((entry) => entry.ok)).toHaveLength(1);
    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(0n);

    unwrap(
      await service.creditWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 100n,
        idempotencyKey: "last-wallet-seed",
        metadata: metadata("last-wallet-seed"),
      }),
    );
    const walletAttempts = await Promise.all([
      service.debitWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 100n,
        idempotencyKey: "last-wallet-a",
        metadata: metadata("last-wallet-a"),
      }),
      service.debitWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 100n,
        idempotencyKey: "last-wallet-b",
        metadata: metadata("last-wallet-b"),
      }),
    ]);
    expect(walletAttempts.filter((entry) => entry.ok)).toHaveLength(1);
    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(0n);

    const losingLedgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger WHERE player_id = $1 AND delta = -1)::text AS inventory,
         (SELECT count(*) FROM wallet_ledger WHERE player_id = $1 AND delta = -100)::text AS wallet`,
      [playerId],
    );
    expect(losingLedgers.rows[0]).toEqual({ inventory: "1", wallet: "1" });
  });

  it("purchases from server-side offer data exactly once and replays after ACTIVE release changes", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    unwrap(
      await service.creditWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 500n,
        idempotencyKey: "purchase-wallet-seed",
        metadata: metadata("purchase-wallet-seed"),
      }),
    );
    const purchaseMeta = metadata("purchase-command");
    const [first, retry] = await Promise.all([
      service.purchase({
        playerId,
        offerKey: "shop.phase6-potion",
        idempotencyKey: "purchase-a",
        metadata: purchaseMeta,
      }),
      service.purchase({
        playerId,
        offerKey: "shop.phase6-potion",
        idempotencyKey: "purchase-a",
        metadata: { ...purchaseMeta, correlationId: randomUUID() },
      }),
    ]);
    const firstValue = unwrap(first);
    const retryValue = unwrap(retry);
    expect([firstValue.replayed, retryValue.replayed].sort()).toEqual([false, true]);
    expect(firstValue.priceAmount).toBe(200n);
    expect(firstValue.itemQuantity).toBe(1n);
    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(300n);
    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(1n);

    const newReleaseId = randomUUID();
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       SELECT $1, 2, 'phase6-next-release', 'DRAFT', default_ruleset_id
       FROM content_releases WHERE id = $2`,
      [newReleaseId, fixture.releaseId],
    );
    await pool.query(
      `UPDATE content_releases SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb, content_fingerprint = $2
       WHERE id = $1`,
      [newReleaseId, "c".repeat(64)],
    );
    await pool.query(
      "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
      [newReleaseId],
    );
    await pool.query(
      "UPDATE content_release_pointers SET content_release_id = $1 WHERE pointer_key = 'ACTIVE'",
      [newReleaseId],
    );
    await pool.query("UPDATE content_releases SET status = 'ARCHIVED' WHERE id = $1", [fixture.releaseId]);

    const afterSwitch = unwrap(
      await service.purchase({
        playerId,
        offerKey: "shop.phase6-potion",
        idempotencyKey: "purchase-a",
        metadata: { ...purchaseMeta, correlationId: randomUUID() },
      }),
    );
    expect(afterSwitch.replayed).toBe(true);
    expect(afterSwitch.contentReleaseId).toBe(fixture.releaseId);
    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(300n);
    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(1n);
  });

  it("rolls back ledger claims and wallet debit if a later purchase step fails", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    unwrap(
      await service.creditWallet({
        playerId,
        currencyId: fixture.currencyId,
        amount: 500n,
        idempotencyKey: "rollback-wallet-seed",
        metadata: metadata("rollback-wallet-seed"),
      }),
    );
    unwrap(
      await service.addItem({
        playerId,
        itemId: fixture.itemId,
        quantity: 9_223_372_036_854_775_807n,
        idempotencyKey: "rollback-item-max",
        metadata: metadata("rollback-item-max"),
      }),
    );

    const failed = await service.purchase({
      playerId,
      offerKey: "shop.phase6-potion",
      idempotencyKey: "purchase-overflow",
      metadata: metadata("purchase-overflow"),
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(500n);
    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(
      9_223_372_036_854_775_807n,
    );

    const purchaseLedgers = await pool.query<{ inventory: string; wallet: string }>(
      `SELECT
         (SELECT count(*) FROM inventory_ledger WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS inventory,
         (SELECT count(*) FROM wallet_ledger WHERE player_id = $1 AND source_type = 'PURCHASE_OFFER')::text AS wallet`,
      [playerId],
    );
    expect(purchaseLedgers.rows[0]).toEqual({ inventory: "0", wallet: "0" });
  });

  it("rejects direct negative balances for normal currency and leaves failed debits ledger-free", async () => {
    const client = await pool.connect();
    const playerId = await createPlayer(client);
    client.release();

    await expect(
      pool.query(
        "INSERT INTO wallet_balances(player_id, currency_id, amount) VALUES ($1, $2, -1)",
        [playerId, fixture.currencyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const failed = await service.debitWallet({
      playerId,
      currencyId: fixture.currencyId,
      amount: 1n,
      idempotencyKey: "empty-wallet-debit",
      metadata: metadata("empty-wallet-debit"),
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    const ledgers = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM wallet_ledger WHERE player_id = $1",
      [playerId],
    );
    expect(ledgers.rows[0]?.count).toBe("0");
  });
});
