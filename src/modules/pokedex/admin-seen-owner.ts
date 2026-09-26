export interface PokedexAdminSeenGrantResult {
  readonly beforeSeenCount: string;
  readonly afterSeenCount: string;
  readonly beforeShinySeenCount: string;
  readonly afterShinySeenCount: string;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly changed: boolean;
}

export interface PokedexAdminSeenOwner {
  grantSeen(input: {
    readonly playerId: string;
    readonly speciesId: string;
    readonly shiny: boolean;
  }): Promise<PokedexAdminSeenGrantResult | null>;
}
