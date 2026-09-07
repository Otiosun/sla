import type { PlayerId } from "../../shared-kernel/ids.js";
import type { Result } from "../../shared-kernel/result.js";

export interface MartSellableInventoryItem {
  readonly offerKey: string;
  readonly itemId: string;
  readonly displayName: string;
  readonly currencyId: string;
  readonly unitSaleAmount: bigint;
  readonly inventoryQuantity: bigint;
}

export interface MartSaleInventoryReader {
  listSellableInventory(
    playerId: PlayerId,
  ): Promise<Result<readonly MartSellableInventoryItem[]>>;
}

const SALE_LIST_PROMPT_SUFFIX = ":mart:sale:list";
const SALE_QUANTITY_PROMPT_MARKER = ":mart:sale:quantity:";
const OFFER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export function isMartSaleListPromptKey(key: string): boolean {
  return key.endsWith(SALE_LIST_PROMPT_SUFFIX);
}

export function martSaleQuantityOfferFromPromptKey(key: string): string | null {
  const markerIndex = key.lastIndexOf(SALE_QUANTITY_PROMPT_MARKER);
  if (markerIndex < 0) return null;
  const offerKey = key.slice(markerIndex + SALE_QUANTITY_PROMPT_MARKER.length).trim();
  return OFFER_KEY_PATTERN.test(offerKey) ? offerKey : null;
}

export function martSaleItemByCode(
  items: readonly MartSellableInventoryItem[],
  input: string,
): MartSellableInventoryItem | null {
  const normalized = input.trim();
  if (!/^[0-9]{1,2}$/.test(normalized)) return null;
  const index = Number(normalized) - 1;
  return Number.isInteger(index) && index >= 0 ? (items[index] ?? null) : null;
}

export function martSaleItemByOfferKey(
  items: readonly MartSellableInventoryItem[],
  offerKey: string,
): MartSellableInventoryItem | null {
  return items.find((item) => item.offerKey === offerKey) ?? null;
}

export function parseMartSaleQuantityReply(
  text: string,
  selected: MartSellableInventoryItem,
): bigint | null {
  const match = /^\s*(.+?)\s*\/\s*([0-9]+)\s*$/.exec(text);
  if (match === null) return null;
  if (match[1]?.localeCompare(selected.displayName, undefined, { sensitivity: "accent" }) !== 0) {
    return null;
  }
  const rawQuantity = match[2];
  if (rawQuantity === undefined) return null;
  const quantity = BigInt(rawQuantity);
  return quantity > 0n ? quantity : null;
}
