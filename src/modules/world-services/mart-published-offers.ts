import { MART_CATALOG, type MartCatalogItem } from "./mart-catalog.js";

export interface MartPublishedOffer {
  readonly offerKey: string;
  readonly itemQuantity: bigint;
  readonly priceAmount: bigint;
}

/** The storefront must list only real, currently published and purchasable offers. */
export interface MartPublishedOfferReader {
  listPublishedOffers(): Promise<readonly MartPublishedOffer[]>;
}

export function purchasableMartItems(
  published: readonly MartPublishedOffer[],
): readonly MartCatalogItem[] {
  const eligible = new Map(published
    .filter((offer) => offer.itemQuantity === 1n && offer.priceAmount > 0n)
    .map((offer) => [offer.offerKey, offer.priceAmount] as const));
  return MART_CATALOG.flatMap((item) => {
    const unitPrice = eligible.get(item.offerKey);
    return unitPrice === undefined ? [] : [{ ...item, unitPrice }];
  });
}
