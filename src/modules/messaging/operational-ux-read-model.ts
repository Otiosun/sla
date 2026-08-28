import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";

export interface OperationalRegionOption {
  readonly regionId: string;
  readonly displayName: string;
}

export interface OperationalTeamMemberView {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly displayName: string;
  readonly level: number;
  readonly currentHp: number;
  readonly slotNo: number;
}

export interface OperationalInventoryItemView {
  readonly itemId: string;
  readonly itemSlug: string;
  readonly displayName: string;
  readonly quantity: bigint;
}

export interface OperationalPokedexSpeciesView {
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly speciesSlug: string;
  readonly displayName: string;
  readonly seenCount: bigint;
  readonly caughtCount: bigint;
}

/**
 * Read-only projection used by messaging presentation. It may join display metadata, but it must
 * never decide or mutate gameplay mechanics; mutations remain owned by the domain services.
 */
export interface OperationalUxReadModel {
  listRegionOptions(playerId: PlayerId): Promise<readonly OperationalRegionOption[]>;
  listTeam(playerId: PlayerId): Promise<readonly OperationalTeamMemberView[]>;
  listInventory(playerId: PlayerId): Promise<readonly OperationalInventoryItemView[]>;
  listPokedex(playerId: PlayerId): Promise<readonly OperationalPokedexSpeciesView[]>;
  activeBattleId(playerId: PlayerId): Promise<string | null>;
  speciesDisplayName(contentReleaseId: string, speciesId: string): Promise<string | null>;
  moveDisplayNames(
    contentReleaseId: string,
    moveIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}
