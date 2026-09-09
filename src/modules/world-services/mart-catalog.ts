export type MartCatalogCategory = "CAPTURE" | "RECOVERY" | "TREATMENT" | "FIELD" | "BATTLE";

export interface MartCatalogItem {
  readonly code: string;
  readonly offerKey: string;
  readonly displayName: string;
  readonly unitPrice: bigint;
  readonly category: MartCatalogCategory;
}

export const MART_CATALOG: readonly MartCatalogItem[] = [
  {
    code: "01",
    offerKey: "shop.poke-ball",
    displayName: "Poké Ball",
    unitPrice: 200n,
    category: "CAPTURE",
  },
  {
    code: "02",
    offerKey: "shop.great-ball",
    displayName: "Great Ball",
    unitPrice: 600n,
    category: "CAPTURE",
  },
  {
    code: "03",
    offerKey: "shop.potion",
    displayName: "Potion",
    unitPrice: 300n,
    category: "RECOVERY",
  },
  {
    code: "04",
    offerKey: "shop.super-potion",
    displayName: "Super Potion",
    unitPrice: 700n,
    category: "RECOVERY",
  },
  {
    code: "05",
    offerKey: "shop.antidote",
    displayName: "Antidote",
    unitPrice: 100n,
    category: "TREATMENT",
  },
  {
    code: "06",
    offerKey: "shop.paralyze-heal",
    displayName: "Paralyze Heal",
    unitPrice: 200n,
    category: "TREATMENT",
  },
  {
    code: "07",
    offerKey: "shop.awakening",
    displayName: "Awakening",
    unitPrice: 250n,
    category: "TREATMENT",
  },
  {
    code: "08",
    offerKey: "shop.burn-heal",
    displayName: "Burn Heal",
    unitPrice: 250n,
    category: "TREATMENT",
  },
  {
    code: "09",
    offerKey: "shop.ice-heal",
    displayName: "Ice Heal",
    unitPrice: 250n,
    category: "TREATMENT",
  },
  {
    code: "10",
    offerKey: "shop.repel",
    displayName: "Repel",
    unitPrice: 350n,
    category: "FIELD",
  },
  {
    code: "11",
    offerKey: "shop.escape-rope",
    displayName: "Escape Rope",
    unitPrice: 550n,
    category: "FIELD",
  },
  {
    code: "12",
    offerKey: "shop.x-attack",
    displayName: "X Attack",
    unitPrice: 350n,
    category: "BATTLE",
  },
  {
    code: "13",
    offerKey: "shop.x-defense",
    displayName: "X Defense",
    unitPrice: 350n,
    category: "BATTLE",
  },
  {
    code: "14",
    offerKey: "shop.x-speed",
    displayName: "X Speed",
    unitPrice: 350n,
    category: "BATTLE",
  },
  {
    code: "15",
    offerKey: "shop.x-sp-atk",
    displayName: "X Sp. Atk",
    unitPrice: 350n,
    category: "BATTLE",
  },
  {
    code: "16",
    offerKey: "shop.x-sp-def",
    displayName: "X Sp. Def",
    unitPrice: 350n,
    category: "BATTLE",
  },
] as const;

export function martItemByCode(input: string): MartCatalogItem | null {
  const normalized = input.trim().padStart(2, "0");
  return MART_CATALOG.find((item) => item.code === normalized) ?? null;
}

export function martItemByOfferKey(offerKey: string): MartCatalogItem | null {
  return MART_CATALOG.find((item) => item.offerKey === offerKey) ?? null;
}

const QUANTITY_PROMPT_MARKER = ":mart:quantity:";

export function martQuantityOfferFromPromptKey(key: string): string | null {
  const markerIndex = key.lastIndexOf(QUANTITY_PROMPT_MARKER);
  if (markerIndex < 0) return null;
  const offerKey = key.slice(markerIndex + QUANTITY_PROMPT_MARKER.length).trim();
  return martItemByOfferKey(offerKey) === null ? null : offerKey;
}

export function isMartCatalogPromptKey(key: string): boolean {
  return key.endsWith(":mart:catalog");
}

export function parseMartQuantityReply(text: string, selected: MartCatalogItem): bigint | null {
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
