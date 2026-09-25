export interface AdminRewardCatalogSpecies {
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly slug: string;
  readonly displayName: string;
}

export interface AdminRewardCatalogItem {
  readonly itemId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly itemKind: string;
}

export interface AdminRewardCatalogCurrency {
  readonly currencyId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly allowsNegative: boolean;
}

export interface AdminRewardCatalogView {
  readonly items: readonly AdminRewardCatalogItem[];
  readonly currencies: readonly AdminRewardCatalogCurrency[];
  readonly species: readonly AdminRewardCatalogSpecies[];
}
