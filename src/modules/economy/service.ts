import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type EconomyMutationMetadata,
  type EconomyMutationMetadataInput,
  EconomyMutationMetadataInputSchema,
  type InventoryLedgerRecord,
  type InventoryMutationResult,
  type PurchaseResult,
  type SaleResult,
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
  saleOfferNotFound,
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
const PURCHASE_FINGERPRINT_SCOPE = scope("economy.purchase");
const PURCHASE_WALLET_SCOPE = scope("economy.purchase.wallet");
const PURCHASE_INVENTORY_SCOPE = scope("economy.purchase.inventory");
const SALE_FINGERPRINT_SCOPE = scope("economy.sale");
const SALE_WALLET_SCOPE = scope("economy.sale.wallet");
const SALE_INVENTORY_SCOPE = scope("economy.sale.inventory");

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

export interface PurchaseQuantityInput extends PurchaseInput {
  readonly quantity: bigint;
}

export interface SaleInput {
  readonly playerId: PlayerId;
  readonly offerKey: string;
  readonly idempotencyKey: string;
  readonly metadata: EconomyMutationMetadataInput;
}

export interface SaleQuantityInput extends SaleInput {
  readonly quantity: bigint;
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

function multiplyPositiveBigInt(label: string, left: bigint, right: bigint): Result<bigint> {
  if (left <= 0n || right <= 0n || left > PG_BIGINT_MAX / right) {
    return err(
      economyValidationError(label, {
        left: left.toString(),
        right: right.toString(),
        max: PG_BIGINT_MAX.toString(),
      }),
    );
  }
  return ok(left * right);
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

function offerMetadata(
  metadata: EconomyMutationMetadata,
  offerId: string,
  sourceType: "PURCHASE_OFFER" | "SALE_OFFER",
): EconomyMutationMetadata {
  return { ...metadata, sourceType, sourceId: offerId };
}

export class EconomyService {
  public constructor(private readonly repository: EconomyRepository) {}

  public async addItem(input: InventoryOperationInput): Promise<Result<InventoryMutationResult>> {
    return this.inventoryMutation(input, INVENTORY_ADD_SCOPE, input.quantity, "ADD");
  }

  public async consumeItem(
    input: InventoryOperationInput,
  ): Promise<Result<InventoryMutationResult>> {
    return this.inventoryMutation(input, INVENTORY_CONSUME_SCOPE, -input.quantity, "CONSUME");
  }

  public async creditWallet(input: WalletOperationInput): Promise<Result<WalletMutationResult>> {
    return this.walletMutation(input, WALLET_CREDIT_SCOPE, input.amount, "CREDIT");
  }

  public async debitWallet(input: WalletOperationInput): Promise<Result<WalletMutationResult>> {
    return this.walletMutation(input, WALLET_DEBIT_SCOPE, -input.amount, "DEBIT");
  }

  public async purchase(input: PurchaseInput): Promise<Result<PurchaseResult>> {
    return this.purchaseQuantity({ ...input, quantity: 1n });
  }

  public async purchaseQuantity(input: PurchaseQuantityInput): Promise<Result<PurchaseResult>> {
    const offerKey = offerKeySchema.safeParse(input.offerKey);
    if (!offerKey.success) {
      return err(economyValidationError("offerKey", offerKey.error.issues));
    }
    const quantity = positiveBigInt("quantity", input.quantity);
    if (!quantity.ok) return quantity;

    const fingerprintMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      PURCHASE_FINGERPRINT_SCOPE,
    );
    if (!fingerprintMetadata.ok) return fingerprintMetadata;
    const walletMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      PURCHASE_WALLET_SCOPE,
    );
    if (!walletMetadata.ok) return walletMetadata;
    const inventoryMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      PURCHASE_INVENTORY_SCOPE,
    );
    if (!inventoryMetadata.ok) return inventoryMetadata;

    return this.withRollback(async () =>
      this.repository.transaction(async (transaction) => {
        await transaction.lockPurchaseFingerprint(
          fingerprintMetadata.value.idempotency.scope,
          fingerprintMetadata.value.idempotency.storageKey,
        );

        const replay = await this.purchaseReplay(
          transaction,
          input.playerId,
          offerKey.data,
          quantity.value,
          walletMetadata.value,
          inventoryMetadata.value,
        );
        if (replay !== null) return replay;

        const contentReleaseId = await transaction.activeContentReleaseId();
        if (contentReleaseId === null) return err(noActiveContentRelease());
        const offer = await transaction.loadPurchaseOffer(contentReleaseId, offerKey.data);
        if (offer === null) return err(purchaseOfferNotFound(contentReleaseId, offerKey.data));

        const totalPrice = multiplyPositiveBigInt(
          "purchase price",
          offer.priceAmount,
          quantity.value,
        );
        if (!totalPrice.ok) return totalPrice;
        const totalItems = multiplyPositiveBigInt(
          "purchase item quantity",
          offer.itemQuantity,
          quantity.value,
        );
        if (!totalItems.ok) return totalItems;

        const walletWriteMetadata = offerMetadata(walletMetadata.value, offer.id, "PURCHASE_OFFER");
        const inventoryWriteMetadata = offerMetadata(
          inventoryMetadata.value,
          offer.id,
          "PURCHASE_OFFER",
        );
        const walletLedgerId = randomUUID();
        const inventoryLedgerId = randomUUID();

        const walletClaimed = await transaction.claimWalletLedger({
          id: walletLedgerId,
          playerId: input.playerId,
          currencyId: offer.currencyId,
          delta: -totalPrice.value,
          metadata: walletWriteMetadata,
        });
        if (!walletClaimed) {
          const racedReplay = await this.purchaseReplay(
            transaction,
            input.playerId,
            offerKey.data,
            quantity.value,
            walletMetadata.value,
            inventoryMetadata.value,
          );
          if (racedReplay !== null) return racedReplay;
          throw new EconomyRollback(
            economyIntegrityError(
              "Purchase idempotency claim lost without a durable replay record",
            ),
          );
        }

        const inventoryClaimed = await transaction.claimInventoryLedger({
          id: inventoryLedgerId,
          playerId: input.playerId,
          itemId: offer.itemId,
          delta: totalItems.value,
          metadata: inventoryWriteMetadata,
        });
        if (!inventoryClaimed) {
          throw new EconomyRollback(
            economyIntegrityError(
              "Purchase has a partial idempotency history across economy ledgers",
            ),
          );
        }

        const walletAmount = await transaction.debitWallet({
          playerId: input.playerId,
          currencyId: offer.currencyId,
          amount: totalPrice.value,
        });
        if (walletAmount === null) {
          throw new EconomyRollback(insufficientWallet(offer.currencyId, totalPrice.value));
        }

        const inventoryQuantity = await transaction.addInventory({
          playerId: input.playerId,
          itemId: offer.itemId,
          quantity: totalItems.value,
        });
        if (inventoryQuantity === null) {
          throw new EconomyRollback(economyBalanceOverflow("inventory"));
        }

        await transaction.finalizeWalletLedgerBalance({
          ledgerId: walletLedgerId,
          balanceAfter: walletAmount,
        });
        await transaction.finalizeInventoryLedgerBalance({
          ledgerId: inventoryLedgerId,
          balanceAfter: inventoryQuantity,
        });

        return ok({
          playerId: input.playerId,
          contentReleaseId: offer.contentReleaseId,
          offerKey: offer.offerKey,
          purchaseQuantity: quantity.value,
          itemId: offer.itemId,
          itemQuantity: totalItems.value,
          inventoryQuantity,
          currencyId: offer.currencyId,
          priceAmount: totalPrice.value,
          walletAmount,
          replayed: false,
        });
      }),
    );
  }

  public async sell(input: SaleInput): Promise<Result<SaleResult>> {
    return this.sellQuantity({ ...input, quantity: 1n });
  }

  public async sellQuantity(input: SaleQuantityInput): Promise<Result<SaleResult>> {
    const offerKey = offerKeySchema.safeParse(input.offerKey);
    if (!offerKey.success) {
      return err(economyValidationError("offerKey", offerKey.error.issues));
    }
    const quantity = positiveBigInt("quantity", input.quantity);
    if (!quantity.ok) return quantity;

    const fingerprintMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      SALE_FINGERPRINT_SCOPE,
    );
    if (!fingerprintMetadata.ok) return fingerprintMetadata;
    const walletMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      SALE_WALLET_SCOPE,
    );
    if (!walletMetadata.ok) return walletMetadata;
    const inventoryMetadata = prepareMetadata(
      input.metadata,
      input.idempotencyKey,
      SALE_INVENTORY_SCOPE,
    );
    if (!inventoryMetadata.ok) return inventoryMetadata;

    return this.withRollback(async () =>
      this.repository.transaction(async (transaction) => {
        await transaction.lockSaleFingerprint(
          fingerprintMetadata.value.idempotency.scope,
          fingerprintMetadata.value.idempotency.storageKey,
        );

        const replay = await this.saleReplay(
          transaction,
          input.playerId,
          offerKey.data,
          quantity.value,
          walletMetadata.value,
          inventoryMetadata.value,
        );
        if (replay !== null) return replay;

        const contentReleaseId = await transaction.activeContentReleaseId();
        if (contentReleaseId === null) return err(noActiveContentRelease());
        const offer = await transaction.loadSaleOffer(contentReleaseId, offerKey.data);
        if (offer === null) return err(saleOfferNotFound(contentReleaseId, offerKey.data));

        const totalSaleAmount = multiplyPositiveBigInt(
          "sale amount",
          offer.saleAmount,
          quantity.value,
        );
        if (!totalSaleAmount.ok) return totalSaleAmount;

        const inventoryWriteMetadata = offerMetadata(
          inventoryMetadata.value,
          offer.id,
          "SALE_OFFER",
        );
        const walletWriteMetadata = offerMetadata(walletMetadata.value, offer.id, "SALE_OFFER");
        const inventoryLedgerId = randomUUID();
        const walletLedgerId = randomUUID();

        const inventoryClaimed = await transaction.claimInventoryLedger({
          id: inventoryLedgerId,
          playerId: input.playerId,
          itemId: offer.itemId,
          delta: -quantity.value,
          metadata: inventoryWriteMetadata,
        });
        if (!inventoryClaimed) {
          const racedReplay = await this.saleReplay(
            transaction,
            input.playerId,
            offerKey.data,
            quantity.value,
            walletMetadata.value,
            inventoryMetadata.value,
          );
          if (racedReplay !== null) return racedReplay;
          throw new EconomyRollback(
            economyIntegrityError("Sale idempotency claim lost without a durable replay record"),
          );
        }

        const walletClaimed = await transaction.claimWalletLedger({
          id: walletLedgerId,
          playerId: input.playerId,
          currencyId: offer.currencyId,
          delta: totalSaleAmount.value,
          metadata: walletWriteMetadata,
        });
        if (!walletClaimed) {
          throw new EconomyRollback(
            economyIntegrityError("Sale has a partial idempotency history across economy ledgers"),
          );
        }

        const inventoryQuantity = await transaction.consumeInventory({
          playerId: input.playerId,
          itemId: offer.itemId,
          quantity: quantity.value,
        });
        if (inventoryQuantity === null) {
          throw new EconomyRollback(insufficientInventory(offer.itemId, quantity.value));
        }

        const walletAmount = await transaction.creditWallet({
          playerId: input.playerId,
          currencyId: offer.currencyId,
          amount: totalSaleAmount.value,
        });
        if (walletAmount === null) {
          throw new EconomyRollback(economyBalanceOverflow("wallet"));
        }

        await transaction.finalizeInventoryLedgerBalance({
          ledgerId: inventoryLedgerId,
          balanceAfter: inventoryQuantity,
        });
        await transaction.finalizeWalletLedgerBalance({
          ledgerId: walletLedgerId,
          balanceAfter: walletAmount,
        });

        return ok({
          playerId: input.playerId,
          contentReleaseId: offer.contentReleaseId,
          offerKey: offer.offerKey,
          saleQuantity: quantity.value,
          itemId: offer.itemId,
          inventoryQuantity,
          currencyId: offer.currencyId,
          saleAmount: totalSaleAmount.value,
          walletAmount,
          replayed: false,
        });
      }),
    );
  }

  public async getInventoryBalance(playerId: PlayerId, itemId: string): Promise<Result<bigint>> {
    const item = uuid("itemId", itemId);
    if (!item.ok) return item;
    return ok(
      await this.repository.read((transaction) =>
        transaction.inventoryBalance(playerId, item.value),
      ),
    );
  }

  public async getWalletBalance(playerId: PlayerId, currencyId: string): Promise<Result<bigint>> {
    const currency = uuid("currencyId", currencyId);
    if (!currency.ok) return currency;
    return ok(
      await this.repository.read((transaction) =>
        transaction.walletBalance(playerId, currency.value),
      ),
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
          return this.inventoryReplay(
            transaction,
            existing,
            input.playerId,
            item.value,
            delta,
            metadata.value,
          );
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
              economyIntegrityError(
                "Inventory idempotency claim lost without a durable ledger row",
              ),
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
        await transaction.finalizeInventoryLedgerBalance({ ledgerId, balanceAfter: balance });

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
        await transaction.finalizeWalletLedgerBalance({ ledgerId, balanceAfter: balance });

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
      quantity: existing.balanceAfter ?? (await transaction.inventoryBalance(playerId, itemId)),
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
      amount: existing.balanceAfter ?? (await transaction.walletBalance(playerId, currencyId)),
      ledgerId: existing.id,
      replayed: true,
    });
  }

  private async purchaseReplay(
    transaction: EconomyTransaction,
    playerId: PlayerId,
    requestedOfferKey: string,
    requestedQuantity: bigint,
    walletMetadata: EconomyMutationMetadata,
    inventoryMetadata: EconomyMutationMetadata,
  ): Promise<Result<PurchaseResult> | null> {
    const walletLedger = await transaction.findWalletLedger(
      walletMetadata.idempotency.scope,
      walletMetadata.idempotency.storageKey,
    );
    const inventoryLedger = await transaction.findInventoryLedger(
      inventoryMetadata.idempotency.scope,
      inventoryMetadata.idempotency.storageKey,
    );

    if (walletLedger === null && inventoryLedger === null) return null;
    if (walletLedger === null || inventoryLedger === null) {
      return err(
        economyIntegrityError("Purchase has a partial idempotency history across economy ledgers"),
      );
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
      return err(
        economyIntegrityError("Purchase replay references an unavailable historical offer"),
      );
    }
    const totalPrice = multiplyPositiveBigInt(
      "purchase price",
      offer.priceAmount,
      requestedQuantity,
    );
    const totalItems = multiplyPositiveBigInt(
      "purchase item quantity",
      offer.itemQuantity,
      requestedQuantity,
    );
    if (!totalPrice.ok || !totalItems.ok) return err(idempotencyReplayMismatch());

    if (
      offer.offerKey !== requestedOfferKey ||
      walletLedger.currencyId !== offer.currencyId ||
      walletLedger.delta !== -totalPrice.value ||
      inventoryLedger.itemId !== offer.itemId ||
      inventoryLedger.delta !== totalItems.value
    ) {
      return err(idempotencyReplayMismatch());
    }

    const walletAmount =
      walletLedger.balanceAfter ?? (await transaction.walletBalance(playerId, offer.currencyId));
    const inventoryQuantity =
      inventoryLedger.balanceAfter ?? (await transaction.inventoryBalance(playerId, offer.itemId));
    return ok({
      playerId,
      contentReleaseId: offer.contentReleaseId,
      offerKey: offer.offerKey,
      purchaseQuantity: requestedQuantity,
      itemId: offer.itemId,
      itemQuantity: totalItems.value,
      inventoryQuantity,
      currencyId: offer.currencyId,
      priceAmount: totalPrice.value,
      walletAmount,
      replayed: true,
    });
  }

  private async saleReplay(
    transaction: EconomyTransaction,
    playerId: PlayerId,
    requestedOfferKey: string,
    requestedQuantity: bigint,
    walletMetadata: EconomyMutationMetadata,
    inventoryMetadata: EconomyMutationMetadata,
  ): Promise<Result<SaleResult> | null> {
    const walletLedger = await transaction.findWalletLedger(
      walletMetadata.idempotency.scope,
      walletMetadata.idempotency.storageKey,
    );
    const inventoryLedger = await transaction.findInventoryLedger(
      inventoryMetadata.idempotency.scope,
      inventoryMetadata.idempotency.storageKey,
    );

    if (walletLedger === null && inventoryLedger === null) return null;
    if (walletLedger === null || inventoryLedger === null) {
      return err(
        economyIntegrityError("Sale has a partial idempotency history across economy ledgers"),
      );
    }
    if (
      walletLedger.playerId !== playerId ||
      inventoryLedger.playerId !== playerId ||
      walletLedger.sourceType !== "SALE_OFFER" ||
      inventoryLedger.sourceType !== "SALE_OFFER" ||
      walletLedger.sourceId !== inventoryLedger.sourceId ||
      !sameActorAndReason(walletLedger, walletMetadata) ||
      !sameActorAndReason(inventoryLedger, inventoryMetadata)
    ) {
      return err(idempotencyReplayMismatch());
    }

    const offer = await transaction.loadSaleOfferById(walletLedger.sourceId);
    if (offer === null) {
      return err(economyIntegrityError("Sale replay references an unavailable historical offer"));
    }
    const totalSaleAmount = multiplyPositiveBigInt(
      "sale amount",
      offer.saleAmount,
      requestedQuantity,
    );
    if (!totalSaleAmount.ok) return err(idempotencyReplayMismatch());

    if (
      offer.offerKey !== requestedOfferKey ||
      walletLedger.currencyId !== offer.currencyId ||
      walletLedger.delta !== totalSaleAmount.value ||
      inventoryLedger.itemId !== offer.itemId ||
      inventoryLedger.delta !== -requestedQuantity
    ) {
      return err(idempotencyReplayMismatch());
    }

    const walletAmount =
      walletLedger.balanceAfter ?? (await transaction.walletBalance(playerId, offer.currencyId));
    const inventoryQuantity =
      inventoryLedger.balanceAfter ?? (await transaction.inventoryBalance(playerId, offer.itemId));
    return ok({
      playerId,
      contentReleaseId: offer.contentReleaseId,
      offerKey: offer.offerKey,
      saleQuantity: requestedQuantity,
      itemId: offer.itemId,
      inventoryQuantity,
      currencyId: offer.currencyId,
      saleAmount: totalSaleAmount.value,
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
