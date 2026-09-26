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
  readonly species?: readonly AdminRewardCatalogSpecies[];
  readonly forms?: readonly AdminRewardCatalogForm[];
  readonly abilities?: readonly AdminRewardCatalogAbility[];
  readonly natures?: readonly AdminRewardCatalogNature[];
  readonly effects?: readonly AdminRewardCatalogEffect[];
  readonly releases?: readonly AdminRewardCatalogRelease[];
}

export interface AdminRewardCatalogForm {
  readonly formId: string;
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly speciesSlug: string;
  readonly formSlug: string;
  readonly displayName: string;
  readonly abilityIds: readonly string[];
}

export interface AdminRewardCatalogAbility {
  readonly abilityId: string;
  readonly slug: string;
}

export interface AdminRewardCatalogNature {
  readonly natureId: string;
  readonly slug: string;
}

export interface AdminRewardCatalogEffect {
  readonly effectId: string;
  readonly slug: string;
  readonly scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA";
}

export interface AdminRewardCatalogRelease {
  readonly releaseId: string;
  readonly releaseNo: string;
  readonly name: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly revision: string;
  readonly parentReleaseId: string | null;
  readonly defaultRulesetId: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}
