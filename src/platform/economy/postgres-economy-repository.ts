import type { Pool, PoolClient } from "pg";
import type {
  InventoryLedgerRecord,
  PurchaseOffer,
  WalletLedgerRecord,
} from "../../modules/economy/contracts.js";
import type {
  EconomyRepository,
  EconomyTransaction,
  InventoryLedgerWrite,
  WalletLedgerWrite,
} from "../../modules/economy/ports.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

const PG_BIGINT_MAX = "9223372036854775807";

interface PurchaseOfferRow {
  readonly id: string;
  readonly content_release_id: string;
  readonly offer_key: string;
  readonly item_id: string;
  readonly currency_id: string;
  readonly item_quantity: string;
  readonly price_amount: string;
  readonly active: boolean;
}

function toPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function toBigInt(value: string): bigint {
  return BigInt(value);
}

function toPurchaseOffer(row: PurchaseOfferRow): PurchaseOffer {
  return {
    id: row.id,
    contentReleaseId: row.content_release_id,
    offerKey: row.offer_key,
    itemId: row.item_id,
    currencyId: row.currency_id,
    itemQuantity: toBigInt(row.item_quantity),
    priceAmount: toBigInt(row.price_amount),
    active: row.active,
  };
}

class PostgresEconomyTransaction implements EconomyTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async findInventoryLedger(
    scope: string,
    storageKey: string,
  ): Promise<InventoryLedgerRecord | null> {
    const result = await this.client.query<{
      id: string;
      player_id: string;
      item_id: string;
      delta: string;
      source_type: string;
      source_id: string;
      reason: string;
      actor_type: string;
      actor_id: string | null;
      idempotency_scope: string;
      idempotency_key: string;
      correlation_id: string;
      balance_after: string | null;
    }>(
      `SELECT id, player_id, item_id, delta::text, source_type, source_id, reason,
              actor_type, actor_id, idempotency_scope, idempotency_key, correlation_id,
              balance_after::text
       FROM inventory_ledger
       WHERE idempotency_scope = $1 AND idempotency_key = $2`,
      [scope, storageKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      playerId: toPlayerId(row.player_id),
      itemId: row.item_id,
      delta: toBigInt(row.delta),
      sourceType: row.source_type,
      sourceId: row.source_id,
      reason: row.reason,
      actorType: row.actor_type,
      actorId: row.actor_id,
      idempotencyScope: row.idempotency_scope,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      balanceAfter: row.balance_after === null ? null : toBigInt(row.balance_after),
    };
  }

  public async findWalletLedger(
    scope: string,
    storageKey: string,
  ): Promise<WalletLedgerRecord | null> {
    const result = await this.client.query<{
      id: string;
      player_id: string;
      currency_id: string;
      delta: string;
      source_type: string;
      source_id: string;
      reason: string;
      actor_type: string;
      actor_id: string | null;
      idempotency_scope: string;
      idempotency_key: string;
      correlation_id: string;
      balance_after: string | null;
    }>(
      `SELECT id, player_id, currency_id, delta::text, source_type, source_id, reason,
              actor_type, actor_id, idempotency_scope, idempotency_key, correlation_id,
              balance_after::text
       FROM wallet_ledger
       WHERE idempotency_scope = $1 AND idempotency_key = $2`,
      [scope, storageKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      playerId: toPlayerId(row.player_id),
      currencyId: row.currency_id,
      delta: toBigInt(row.delta),
      sourceType: row.source_type,
      sourceId: row.source_id,
      reason: row.reason,
      actorType: row.actor_type,
      actorId: row.actor_id,
      idempotencyScope: row.idempotency_scope,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      balanceAfter: row.balance_after === null ? null : toBigInt(row.balance_after),
    };
  }

  public async claimInventoryLedger(input: InventoryLedgerWrite): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO inventory_ledger(
         id, player_id, item_id, delta, source_type, source_id, reason, actor_type, actor_id,
         idempotency_scope, idempotency_key, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
      [
        input.id,
        input.playerId,
        input.itemId,
        input.delta.toString(),
        input.metadata.sourceType,
        input.metadata.sourceId,
        input.metadata.reason,
        input.metadata.actorType,
        input.metadata.actorId,
        input.metadata.idempotency.scope,
        input.metadata.idempotency.storageKey,
        input.metadata.correlationId,
      ],
    );
    return result.rowCount === 1;
  }

  public async claimWalletLedger(input: WalletLedgerWrite): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO wallet_ledger(
         id, player_id, currency_id, delta, source_type, source_id, reason, actor_type, actor_id,
         idempotency_scope, idempotency_key, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
      [
        input.id,
        input.playerId,
        input.currencyId,
        input.delta.toString(),
        input.metadata.sourceType,
        input.metadata.sourceId,
        input.metadata.reason,
        input.metadata.actorType,
        input.metadata.actorId,
        input.metadata.idempotency.scope,
        input.metadata.idempotency.storageKey,
        input.metadata.correlationId,
      ],
    );
    return result.rowCount === 1;
  }

  public async finalizeInventoryLedgerBalance(input: {
    readonly ledgerId: string;
    readonly balanceAfter: bigint;
  }): Promise<void> {
    const result = await this.client.query(
      `UPDATE inventory_ledger
       SET balance_after = $2
       WHERE id = $1 AND balance_after IS NULL`,
      [input.ledgerId, input.balanceAfter.toString()],
    );
    if (result.rowCount !== 1) {
      const existing = await this.client.query<{ balance_after: string | null }>(
        `SELECT balance_after::text FROM inventory_ledger WHERE id = $1`,
        [input.ledgerId],
      );
      if (existing.rows[0]?.balance_after !== input.balanceAfter.toString()) {
        throw new Error("Inventory ledger durable result conflict");
      }
    }
  }

  public async finalizeWalletLedgerBalance(input: {
    readonly ledgerId: string;
    readonly balanceAfter: bigint;
  }): Promise<void> {
    const result = await this.client.query(
      `UPDATE wallet_ledger
       SET balance_after = $2
       WHERE id = $1 AND balance_after IS NULL`,
      [input.ledgerId, input.balanceAfter.toString()],
    );
    if (result.rowCount !== 1) {
      const existing = await this.client.query<{ balance_after: string | null }>(
        `SELECT balance_after::text FROM wallet_ledger WHERE id = $1`,
        [input.ledgerId],
      );
      if (existing.rows[0]?.balance_after !== input.balanceAfter.toString()) {
        throw new Error("Wallet ledger durable result conflict");
      }
    }
  }

  public async addInventory(input: {
    readonly playerId: PlayerId;
    readonly itemId: string;
    readonly quantity: bigint;
  }): Promise<bigint | null> {
    const result = await this.client.query<{ quantity: string }>(
      `INSERT INTO inventory_balances(player_id, item_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, item_id)
       DO UPDATE SET quantity = inventory_balances.quantity + EXCLUDED.quantity,
                     revision = inventory_balances.revision + 1,
                     updated_at = now()
       WHERE inventory_balances.quantity <= $4::bigint - EXCLUDED.quantity
       RETURNING quantity::text`,
      [input.playerId, input.itemId, input.quantity.toString(), PG_BIGINT_MAX],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBigInt(row.quantity);
  }

  public async consumeInventory(input: {
    readonly playerId: PlayerId;
    readonly itemId: string;
    readonly quantity: bigint;
  }): Promise<bigint | null> {
    const result = await this.client.query<{ quantity: string }>(
      `UPDATE inventory_balances
       SET quantity = quantity - $3::bigint, revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND item_id = $2 AND quantity >= $3::bigint
       RETURNING quantity::text`,
      [input.playerId, input.itemId, input.quantity.toString()],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBigInt(row.quantity);
  }

  public async creditWallet(input: {
    readonly playerId: PlayerId;
    readonly currencyId: string;
    readonly amount: bigint;
  }): Promise<bigint | null> {
    const result = await this.client.query<{ amount: string }>(
      `INSERT INTO wallet_balances(player_id, currency_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, currency_id)
       DO UPDATE SET amount = wallet_balances.amount + EXCLUDED.amount,
                     revision = wallet_balances.revision + 1,
                     updated_at = now()
       WHERE wallet_balances.amount <= $4::bigint - EXCLUDED.amount
       RETURNING amount::text`,
      [input.playerId, input.currencyId, input.amount.toString(), PG_BIGINT_MAX],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBigInt(row.amount);
  }

  public async debitWallet(input: {
    readonly playerId: PlayerId;
    readonly currencyId: string;
    readonly amount: bigint;
  }): Promise<bigint | null> {
    const result = await this.client.query<{ amount: string }>(
      `UPDATE wallet_balances
       SET amount = amount - $3::bigint, revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND currency_id = $2 AND amount >= $3::bigint
       RETURNING amount::text`,
      [input.playerId, input.currencyId, input.amount.toString()],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBigInt(row.amount);
  }

  public async inventoryBalance(playerId: PlayerId, itemId: string): Promise<bigint> {
    const result = await this.client.query<{ quantity: string }>(
      `SELECT quantity::text FROM inventory_balances WHERE player_id = $1 AND item_id = $2`,
      [playerId, itemId],
    );
    return toBigInt(result.rows[0]?.quantity ?? "0");
  }

  public async walletBalance(playerId: PlayerId, currencyId: string): Promise<bigint> {
    const result = await this.client.query<{ amount: string }>(
      `SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2`,
      [playerId, currencyId],
    );
    return toBigInt(result.rows[0]?.amount ?? "0");
  }

  public async activeContentReleaseId(): Promise<string | null> {
    const result = await this.client.query<{ content_release_id: string }>(
      `SELECT content_release_id
       FROM content_release_pointers
       WHERE pointer_key = 'ACTIVE'
       FOR SHARE`,
    );
    return result.rows[0]?.content_release_id ?? null;
  }

  public async loadPurchaseOffer(
    contentReleaseId: string,
    offerKey: string,
  ): Promise<PurchaseOffer | null> {
    const result = await this.client.query<PurchaseOfferRow>(
      `SELECT offer.id, offer.content_release_id, offer.offer_key, offer.item_id,
              offer.currency_id, offer.item_quantity::text, offer.price_amount::text, offer.active
       FROM item_purchase_offers offer
       JOIN content_releases release ON release.id = offer.content_release_id
       JOIN item_revisions item
         ON item.content_release_id = offer.content_release_id
        AND item.item_id = offer.item_id
        AND item.active = TRUE
       WHERE offer.content_release_id = $1
         AND offer.offer_key = $2
         AND offer.active = TRUE
         AND release.status = 'PUBLISHED'`,
      [contentReleaseId, offerKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPurchaseOffer(row);
  }

  public async loadPurchaseOfferById(offerId: string): Promise<PurchaseOffer | null> {
    const result = await this.client.query<PurchaseOfferRow>(
      `SELECT offer.id, offer.content_release_id, offer.offer_key, offer.item_id,
              offer.currency_id, offer.item_quantity::text, offer.price_amount::text, offer.active
       FROM item_purchase_offers offer
       JOIN content_releases release ON release.id = offer.content_release_id
       WHERE offer.id = $1 AND release.status IN ('PUBLISHED', 'ARCHIVED')`,
      [offerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPurchaseOffer(row);
  }
}

export class PostgresEconomyRepository implements EconomyRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: EconomyTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresEconomyTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: EconomyTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresEconomyTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
