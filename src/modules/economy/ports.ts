import type { PlayerId } from "../../shared-kernel/ids.js";
import type {
  EconomyMutationMetadata,
  InventoryLedgerRecord,
  PurchaseOffer,
  WalletLedgerRecord,
} from "./contracts.js";

export interface InventoryLedgerWrite {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly itemId: string;
  readonly delta: bigint;
  readonly metadata: EconomyMutationMetadata;
}

export interface WalletLedgerWrite {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly currencyId: string;
  readonly delta: bigint;
  readonly metadata: EconomyMutationMetadata;
}

export interface EconomyTransaction {
  findInventoryLedger(scope: string, storageKey: string): Promise<InventoryLedgerRecord | null>;
  findWalletLedger(scope: string, storageKey: string): Promise<WalletLedgerRecord | null>;

  claimInventoryLedger(input: InventoryLedgerWrite): Promise<boolean>;
  claimWalletLedger(input: WalletLedgerWrite): Promise<boolean>;

  addInventory(input: {
    readonly playerId: PlayerId;
    readonly itemId: string;
    readonly quantity: bigint;
  }): Promise<bigint | null>;
  consumeInventory(input: {
    readonly playerId: PlayerId;
    readonly itemId: string;
    readonly quantity: bigint;
  }): Promise<bigint | null>;

  creditWallet(input: {
    readonly playerId: PlayerId;
    readonly currencyId: string;
    readonly amount: bigint;
  }): Promise<bigint | null>;
  debitWallet(input: {
    readonly playerId: PlayerId;
    readonly currencyId: string;
    readonly amount: bigint;
  }): Promise<bigint | null>;

  inventoryBalance(playerId: PlayerId, itemId: string): Promise<bigint>;
  walletBalance(playerId: PlayerId, currencyId: string): Promise<bigint>;

  activeContentReleaseId(): Promise<string | null>;
  loadPurchaseOffer(contentReleaseId: string, offerKey: string): Promise<PurchaseOffer | null>;
}

export interface EconomyRepository {
  transaction<T>(work: (transaction: EconomyTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: EconomyTransaction) => Promise<T>): Promise<T>;
}
