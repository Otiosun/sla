import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type EconomyMutationMetadata,
  type EconomyMutationMetadataInput,
  EconomyMutationMetadataInputSchema,
  type InventoryLedgerRecord,
  type InventoryMutationResult,
  type PurchaseResult,
  type WalletLedgerRecord,
  type WalletMutationResult,
} from "./contracts.js";
import {
  economyBalanceOverflow,
  economyIntegrityError,
  economyValidationError,
  idempotencyReplayMismatch,
  insufficientInventory,
  insufficientWallet,
  noActiveContentRelease,
  purchaseOfferNotFound,
} from "./errors.js";
import type { EconomyRepository, EconomyTransaction } from "./ports.js";
import { parseCorrelationId, type PlayerId } from "../../shared-kernel/ids.js";
import {
  createIdempotencyKey,
  type IdempotencyScope,
  parseIdempotencyScope,
} from "../../shared-kernel/idempotency.js";
import { type AppError, err, ok, type Result } from "../../shared-kernel/result.js";

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const uuidSchema = z.string().uuid();
const offerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);

const INVENTORY_ADD_SCOPE = scope("inventory.add");
const INVENTORY_CONSUME_SCOPE = scope("inventory.consume");
const WALLET_CREDIT_SCOPE = scope("wallet.credit");
const WALLET_DEBIT_SCOPE = scope("wallet.debit");
const PURCHASE_WALLET_SCOPE = scope("economy.purchase.wallet");
const PURCHASE_INVENTORY_SCOPE = scope("economy.purchase.inventory");

interface InventoryOperationInput {
  readonly playerId: PlayerId;
  readonly itemId: string;
  readonly quantity: bigint;
  readonly idempotencyKey: string;
  readonly metadata: EconomyMutationMetadataInput;
}

interface WalletOperationInput {
  readonly playerId: PlayerId;
  readonly currencyId: string;
  readonly amount: bigint;
  readonly idempotencyKey: string;
  readonly metadata: EconomyMutationMetadataInput;
}

export interface PurchaseInput {
  readonly playerId: PlayerId;
  readonly offerKey: string;
  readonly idempotencyKey: string;
  readonly metadata: EconomyMutationMetadataInput;
}

class EconomyRollback extends Error {
  public constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = "EconomyRollback";
  }
}

function scope(value: string): IdempotencyScope {
  const parsed = parseIdempotencyScope(value);
  if (!parsed.ok) throw new Error(`Invalid hardcoded economy idempotency scope: ${value}`);
  return parsed.value;
}

function positiveBigInt(label: string, value: bigint): Result<bigint> {
  if (typeof value !== "bigint" || value <= 0n || value > PG_BIGINT_MAX) {
    return err(
      economyValidationError(label, {
        value: typeof value === "bigint" ? value.toString() : String(value),
        min: "1",
        max: PG_BIGINT_MAX.toString(),
      }),
    );
  }
  return ok(value);
}

function uuid(label: string, value: string): Result<string> {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(economyValidationError(label, parsed.error.issues));
}

function prepareMetadata(
  input: EconomyMutationMetadataInput,
  externalIdempotencyKey: string,
  idempotencyScope: IdempotencyScope,
): Result<EconomyMutationMetadata> {
  const parsed = EconomyMutationMetadataInputSchema.safeParse(input);
  if (!parsed.success) return err(economyValidationError("economy metadata", parsed.error.issues));

  const correlation = parseCorrelationId(parsed.data.correlationId);
  if (!correlation.ok) return correlation;
  const idempotency = createIdempotencyKey(idempotencyScope, externalIdempotencyKey);
  if (!idempotency.ok) return idempotency;

  return ok({
    sourceType: parsed.data.sourceType,
    sourceId: parsed.data.sourceId,
    reason: parsed.data.reason,
    actorType: parsed.data.actorType,
    actorId: parsed.data.actorId,
    correlationId: correlation.value,
    idempotency: idempotency.value,
  });
}

function sameAuditMetadata(
  record: InventoryLedgerRecord | WalletLedgerRecord,
  metadata: EconomyMutationMetadata,
): boolean {
  return (
    record.sourceType === metadata.sourceType &&
    record.sourceId === metadata.sourceId &&
    record.reason === metadata.reason &&
    record.actorType === metadata.actorType &&
    record.actorId === metadata.actorId
  );
}

function sameActorAndReason(
  record: InventoryLedgerRecord | WalletLedgerRecord,
  metadata: EconomyMutationMetadata,
): boolean {
  return (
    record.reason === metadata.reason &&
    record.actorType === metadata.actorType &&
    record.actorId === metadata.actorId
  );
}

function purchaseMetadata(
  metadata: EconomyMutationMetadata,
  offerId: string,
): EconomyMutationMetadata {
  return { ...metadata, sourceType: "PURCHASE_OFFER", sourceId: offerId };
}

export class EconomyService {
  public constructor(private readonly repository: EconomyRepository) {}

  public async addItem(input: InventoryOperationInput): Promise<Result<InventoryMutationResult>> {
    return this.inventoryMutation(input, INVENTORY_ADD_SCOPE, input.quantity, "ADD");
  }

  public async consumeItem(input: InventoryOperationInput): Promise<Result<InventoryMutationResult>> {
    return this.inventoryMutation(input, INVENTORY_CONSUME_SCOPE, -input.quantity, "CONSUME");
  }

  public async creditWallet(input: WalletOperationInput): Promise<Result<WalletMutationResult>> {
    return this.walletMutation(input, WALLET_CREDIT_SCOPE, input.amount, "CREDIT");
  }

  public async debitWallet(input: WalletOperationInput): Promise<Result<WalletMutationResult>> {
    return this.walletMutation(input, WALLET_DEBIT_SCOPE, -input.amount, "DEBIT");
  }

  public async purchase(input: PurchaseInput): Promise<Result<PurchaseResult>> {
    const offerKey = offerKeySchema.safeParse(input.offerKey);
    if (!offerKey.success) {
      return err(economyValidationError("offerKey", offerKey.error.issues));
    }

    const walletMetadata = prepareMetadata(input.metadata, input.idempotencyKey, PURCHASE_WALLET_SCOPE);
    if (!walletMetadata.ok) return walletMetadata;
    const inventoryMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      PURCHASE_INVENTORY_SCOPE,
    );
    if (!inventoryMetadata.ok) return inventoryMetadata;

    return this.withRollback(async () =>
      this.repository.transaction(async (transaction) => {
        const replay = await this.purchaseReplay(
          transaction,
          input.playerId,
          offerKey.data,
          walletMetadata.value,
          inventoryMetadata.value,
        );
        if (replay !== null) return replay;

        const contentReleaseId = await transaction.activeContentReleaseId();
        if (contentReleaseId === null) return err(noActiveContentRelease());
        const offer = await transaction.loadPurchaseOffer(contentReleaseId, offerKey.data);
        if (offer === null) return err(purchaseOfferNotFound(contentReleaseId, offerKey.data));

        const walletWriteMetadata = purchaseMetadata(walletMetadata.value, offer.id);
        const inventoryWriteMetadata = purchaseMetadata(inventoryMetadata.value, offer.id);

        const walletClaimed = await transaction.claimWalletLedger({
          id: randomUUID(),
          playerId: input.playerId,
          currencyId: offer.currencyId,
          delta: -offer.priceAmount,
          metadata: walletWriteMetadata,
        });
        if (!walletClaimed) {
          const racedReplay = await this.purchaseReplay(
            transaction,
            input.playerId,
            offerKey.data,
            walletMetadata.value,
            inventoryMetadata.value,
          );
          if (racedReplay !== null) return racedReplay;
          throw new EconomyRollback(
            economyIntegrityError("Purchase idempotency claim lost without a durable replay record"),
          );
        }

        const inventoryClaimed = await transaction.claimInventoryLedger({
          id: randomUUID(),
          playerId: input.playerId,
          itemId: offer.itemId,
          delta: offer.itemQuantity,
          metadata: inventoryWriteMetadata,
        });
        if (!inventoryClaimed) {
          throw new EconomyRollback(
            economyIntegrityError("Purchase has a partial idempotency history across economy ledgers"),
          );
        }

        const walletAmount = await transaction.debitWallet({
          playerId: input.playerId,
          currencyId: offer.currencyId,
          amount: offer.priceAmount,
        });
        if (walletAmount === null) {
          throw new EconomyRollback(insufficientWallet(offer.currencyId, offer.priceAmount));
        }

        const inventoryQuantity = await transaction.addInventory({
          playerId: input.playerId,
          itemId: offer.itemId,
          quantity: offer.itemQuantity,
        });
        if (inventoryQuantity === null) {
          throw new EconomyRollback(economyBalanceOverflow("inventory"));
        }

        return ok({
          playerId: input.playerId,
          contentReleaseId: offer.contentReleaseId,
          offerKey: offer.offerKey,
          itemId: offer.itemId,
          itemQuantity: offer.itemQuantity,
          inventoryQuantity,
          currencyId: offer.currencyId,
          priceAmount: offer.priceAmount,
          walletAmount,
          replayed: false,
        });
      }),
    );
  }

  public async getInventoryBalance(playerId: PlayerId, itemId: string): Promise<Result<bigint>> {
    const item = uuid("itemId", itemId);
    if (!item.ok) return item;
    return ok(await this.repository.read((transaction) => transaction.inventoryBalance(playerId, item.value)));
  }

  public async getWalletBalance(playerId: PlayerId, currencyId: string): Promise<Result<bigint>> {
    const currency = uuid("currencyId", currencyId);
    if (!currency.ok) return currency;
    return ok(
      await this.repository.read((transaction) => transaction.walletBalance(playerId, currency.value)),
    );
  }

  private async inventoryMutation(
    input: InventoryOperationInput,
    idempotencyScope: IdempotencyScope,
    delta: bigint,
    operation: "ADD" | "CONSUME",
  ): Promise<Result<InventoryMutationResult>> {
    const item = uuid("itemId", input.itemId);
    if (!item.ok) return item;
    const quantity = positiveBigInt("quantity", input.quantity);
    if (!quantity.ok) return quantity;
    const metadata = prepareMetadata(input.metadata, input.idempotencyKey, idempotencyScope);
    if (!metadata.ok) return metadata;

    return this.withRollback(async () =>
      this.repository.transaction(async (transaction) => {
        const existing = await transaction.findInventoryLedger(
          metadata.value.idempotency.scope,
          metadata.value.idempotency.storageKey,
        );
        if (existing !== null) {
          return this.inventoryReplay(transaction, existing, input.playerId, item.value, delta, metadata.value);
        }

        const ledgerId = randomUUID();
        const claimed = await transaction.claimInventoryLedger({
          id: ledgerId,
          playerId: input.playerId,
          itemId: item.value,
          delta,
          metadata: metadata.value,
        });
        if (!claimed) {
          const raced = await transaction.findInventoryLedger(
            metadata.value.idempotency.scope,
            metadata.value.idempotency.storageKey,
          );
          if (raced === null) {
            return err(
              economyIntegrityError("Inventory idempotency claim lost without a durable ledger row"),
            );
          }
          return this.inventoryReplay(
            transaction,
            raced,
            input.playerId,
            item.value,
            delta,
            metadata.value,
          );
        }

        const balance =
          operation === "ADD"
            ? await transaction.addInventory({
                playerId: input.playerId,
                itemId: item.value,
                quantity: quantity.value,
              })
            : await transaction.consumeInventory({
                playerId: input.playerId,
                itemId: item.value,
                quantity: quantity.value,
              });

        if (balance === null) {
          throw new EconomyRollback(
            operation === "ADD"
              ? economyBalanceOverflow("inventory")
              : insufficientInventory(item.value, quantity.value),
          );
        }

        return ok({
          playerId: input.playerId,
          itemId: item.value,
          delta,
          quantity: balance,
          ledgerId,
          replayed: false,
        });
      }),
    );
  }

  private async walletMutation(
    input: WalletOperationInput,
    idempotencyScope: IdempotencyScope,
    delta: bigint,
    operation: "CREDIT" | "DEBIT",
  ): Promise<Result<WalletMutationResult>> {
    const currency = uuid("currencyId", input.currencyId);
    if (!currency.ok) return currency;
    const amount = positiveBigInt("amount", input.amount);
    if (!amount.ok) return amount;
    const metadata = prepareMetadata(input.metadata, input.idempotencyKey, idempotencyScope);
    if (!metadata.ok) return metadata;

    return this.withRollback(async () =>
      this.repository.transaction(async (transaction) => {
        const existing = await transaction.findWalletLedger(
          metadata.value.idempotency.scope,
          metadata.value.idempotency.storageKey,
        );
        if (existing !== null) {
          return this.walletReplay(
            transaction,
            existing,
            input.playerId,
            currency.value,
            delta,
            metadata.value,
          );
        }

        const ledgerId = randomUUID();
        const claimed = await transaction.claimWalletLedger({
          id: ledgerId,
          playerId: input.playerId,
          currencyId: currency.value,
          delta,
          metadata: metadata.value,
        });
        if (!claimed) {
          const raced = await transaction.findWalletLedger(
            metadata.value.idempotency.scope,
            metadata.value.idempotency.storageKey,
          );
          if (raced === null) {
            return err(
              economyIntegrityError("Wallet idempotency claim lost without a durable ledger row"),
            );
          }
          return this.walletReplay(
            transaction,
            raced,
            input.playerId,
            currency.value,
            delta,
            metadata.value,
          );
        }

        const balance =
          operation === "CREDIT"
            ? await transaction.creditWallet({
                playerId: input.playerId,
                currencyId: currency.value,
                amount: amount.value,
              })
            : await transaction.debitWallet({
                playerId: input.playerId,
                currencyId: currency.value,
                amount: amount.value,
              });

        if (balance === null) {
          throw new EconomyRollback(
            operation === "CREDIT"
              ? economyBalanceOverflow("wallet")
              : insufficientWallet(currency.value, amount.value),
          );
        }

        return ok({
          playerId: input.playerId,
          currencyId: currency.value,
          delta,
          amount: balance,
          ledgerId,
          replayed: false,
        });
      }),
    );
  }

  private async inventoryReplay(
    transaction: EconomyTransaction,
    existing: InventoryLedgerRecord,
    playerId: PlayerId,
    itemId: string,
    delta: bigint,
    metadata: EconomyMutationMetadata,
  ): Promise<Result<InventoryMutationResult>> {
    if (
      existing.playerId !== playerId ||
      existing.itemId !== itemId ||
      existing.delta !== delta ||
      !sameAuditMetadata(existing, metadata)
    ) {
      return err(idempotencyReplayMismatch());
    }
    return ok({
      playerId,
      itemId,
      delta,
      quantity: await transaction.inventoryBalance(playerId, itemId),
      ledgerId: existing.id,
      replayed: true,
    });
  }

  private async walletReplay(
    transaction: EconomyTransaction,
    existing: WalletLedgerRecord,
    playerId: PlayerId,
    currencyId: string,
    delta: bigint,
    metadata: EconomyMutationMetadata,
  ): Promise<Result<WalletMutationResult>> {
    if (
      existing.playerId !== playerId ||
      existing.currencyId !== currencyId ||
      existing.delta !== delta ||
      !sameAuditMetadata(existing, metadata)
    ) {
      return err(idempotencyReplayMismatch());
    }
    return ok({
      playerId,
      currencyId,
      delta,
      amount: await transaction.walletBalance(playerId, currencyId),
      ledgerId: existing.id,
      replayed: true,
    });
  }

  private async purchaseReplay(
    transaction: EconomyTransaction,
    playerId: PlayerId,
    requestedOfferKey: string,
    walletMetadata: EconomyMutationMetadata,
    inventoryMetadata: EconomyMutationMetadata,
  ): Promise<Result<PurchaseResult> | null> {
    const [walletLedger, inventoryLedger] = await Promise.all([
      transaction.findWalletLedger(
        walletMetadata.idempotency.scope,
        walletMetadata.idempotency.storageKey,
      ),
      transaction.findInventoryLedger(
        inventoryMetadata.idempotency.scope,
        inventoryMetadata.idempotency.storageKey,
      ),
    ]);

    if (walletLedger === null && inventoryLedger === null) return null;
    if (walletLedger === null || inventoryLedger === null) {
      return err(economyIntegrityError("Purchase has a partial idempotency history across economy ledgers"));
    }
    if (
      walletLedger.playerId !== playerId ||
      inventoryLedger.playerId !== playerId ||
      walletLedger.sourceType !== "PURCHASE_OFFER" ||
      inventoryLedger.sourceType !== "PURCHASE_OFFER" ||
      walletLedger.sourceId !== inventoryLedger.sourceId ||
      !sameActorAndReason(walletLedger, walletMetadata) ||
      !sameActorAndReason(inventoryLedger, inventoryMetadata)
    ) {
      return err(idempotencyReplayMismatch());
    }

    const offer = await transaction.loadPurchaseOfferById(walletLedger.sourceId);
    if (offer === null) {
      return err(economyIntegrityError("Purchase replay references an unavailable historical offer"));
    }
    if (
      offer.offerKey !== requestedOfferKey ||
      walletLedger.currencyId !== offer.currencyId ||
      walletLedger.delta !== -offer.priceAmount ||
      inventoryLedger.itemId !== offer.itemId ||
      inventoryLedger.delta !== offer.itemQuantity
    ) {
      return err(idempotencyReplayMismatch());
    }

    const [walletAmount, inventoryQuantity] = await Promise.all([
      transaction.walletBalance(playerId, offer.currencyId),
      transaction.inventoryBalance(playerId, offer.itemId),
    ]);
    return ok({
      playerId,
      contentReleaseId: offer.contentReleaseId,
      offerKey: offer.offerKey,
      itemId: offer.itemId,
      itemQuantity: offer.itemQuantity,
      inventoryQuantity,
      currencyId: offer.currencyId,
      priceAmount: offer.priceAmount,
      walletAmount,
      replayed: true,
    });
  }

  private async withRollback<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof EconomyRollback) return err(error.appError);
      throw error;
    }
  }
}
