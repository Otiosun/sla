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

export interface OperationalPokemonDetailView {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly slotNo: number;
  readonly displayName: string;
  readonly nickname: string | null;
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly gender: "MALE" | "FEMALE" | null;
  readonly shiny: boolean;
  readonly natureDisplayName: string;
  readonly abilityDisplayName: string;
  readonly ivs: Readonly<{
    hp: number;
    attack: number;
    defense: number;
    spAttack: number;
    spDefense: number;
    speed: number;
  }>;
  readonly statuses: readonly string[];
  readonly moves: readonly {
    readonly slotNo: number;
    readonly displayName: string;
    readonly ppCurrent: number | null;
    readonly maxPp: number | null;
  }[];
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

export interface OperationalPendingMoveChoiceView {
  readonly choiceId: string;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly pokemonDisplayName: string;
  readonly learnLevel: number;
  readonly moveId: string;
  readonly moveDisplayName: string;
  readonly currentMoves: readonly {
    readonly slotNo: number;
    readonly moveId: string;
    readonly displayName: string;
  }[];
}

/**
 * Read-only projection used by messaging presentation. It may join display metadata, but it must
 * never decide or mutate gameplay mechanics; mutations remain owned by the domain services.
 */
export interface OperationalUxReadModel {
  listRegionOptions(playerId: PlayerId): Promise<readonly OperationalRegionOption[]>;
  listTeam(playerId: PlayerId): Promise<readonly OperationalTeamMemberView[]>;
  teamPokemonDetail(
    playerId: PlayerId,
    slotNo: number,
  ): Promise<OperationalPokemonDetailView | null>;
  listInventory(playerId: PlayerId): Promise<readonly OperationalInventoryItemView[]>;
  listPokedex(playerId: PlayerId): Promise<readonly OperationalPokedexSpeciesView[]>;
  listPendingMoveChoices(
    playerId: PlayerId,
  ): Promise<readonly OperationalPendingMoveChoiceView[]>;
  activeBattleId(playerId: PlayerId): Promise<string | null>;
  speciesDisplayName(contentReleaseId: string, speciesId: string): Promise<string | null>;
  moveDisplayNames(
    contentReleaseId: string,
    moveIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}
