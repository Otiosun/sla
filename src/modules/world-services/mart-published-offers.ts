import { MART_CATALOG, type MartCatalogItem } from "./mart-catalog.js";

export interface MartPublishedOffer {
  readonly offerKey: string;
  readonly itemQuantity: bigint;
  readonly priceAmount: bigint;
  readonly displayName?: string;
  readonly itemKind?: string;
}

/** The storefront must list only real, currently published and purchasable offers. */
export interface MartPublishedOfferReader {
  listPublishedOffers(): Promise<readonly MartPublishedOffer[]>;
}

/** Only active offers from published content. No hardcoded imaginary stock. */
export function purchasableMartItems(
  published: readonly MartPublishedOffer[],
): readonly MartCatalogItem[] {
  const valid = published.filter((offer) => offer.itemQuantity === 1n && offer.priceAmount > 0n);
  const unique = new Map(valid.map((offer) => [offer.offerKey, offer] as const));
  const known: MartCatalogItem[] = [];
  for (const template of MART_CATALOG) {
    const available = unique.get(template.offerKey);
    if (available === undefined) continue;
    known.push({ ...template, unitPrice: available.priceAmount });
    unique.delete(template.offerKey);
  }
  // Additional published items (evolution stones, TMs, event-supplies) must
  // use the catalog's own display names. Never generate a fictional item.
  const dynamic = [...unique.values()].filter(
    (entry) => typeof entry.displayName === "string" && entry.displayName.trim().length > 0,
  );
  dynamic.sort((a, b) => a.offerKey.localeCompare(b.offerKey));
  const custom: MartCatalogItem[] = dynamic.map((entry, index) => {
    const kind = (entry.itemKind ?? "").toUpperCase();
    const category =
      kind === "TM" || kind === "MACHINE"
        ? ("TM" as const)
        : kind === "EVOLUTION" || kind === "EVOLUTION_STONE"
          ? ("EVOLUTION" as const)
          : ("OTHER" as const);
    return {
      code: String(MART_CATALOG.length + index + 1).padStart(2, "0"),
      offerKey: entry.offerKey,
      displayName: entry.displayName ?? "",
      unitPrice: entry.priceAmount,
      category,
    };
  });
  return [...known, ...custom];
}
