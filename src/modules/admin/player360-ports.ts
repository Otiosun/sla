import type {
  Player360SearchItemView,
  Player360SearchCursor,
  Player360View,
  PlayerStatus,
} from "./player360-contracts.js";

export interface Player360SearchQuery {
  readonly status: PlayerStatus | null;
  readonly trainerNamePrefix: string | null;
  readonly originRegionId: string | null;
  readonly identityProvider: string | null;
  readonly externalId: string | null;
  readonly includeSensitive: boolean;
  readonly limit: number;
  readonly cursor: Player360SearchCursor | null;
}

export interface Player360ReadRepository {
  getPlayer360(playerId: string, includeSensitive: boolean): Promise<Player360View | null>;
  searchPlayers(query: Player360SearchQuery): Promise<{
    readonly items: readonly Player360SearchItemView[];
    readonly hasMore: boolean;
  }>;
}
