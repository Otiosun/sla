import type { PlayerId } from "../../shared-kernel/ids.js";
import type {
  PlayerLocationRecord,
  WorldAreaRecord,
  WorldConnectionRecord,
  WorldFlowState,
  WorldPlayerEligibility,
} from "./contracts.js";

export interface WorldTransaction {
  activeContentReleaseId(): Promise<string | null>;
  playerEligibility(playerId: PlayerId): Promise<WorldPlayerEligibility | null>;
  playerLocation(playerId: PlayerId, lock?: boolean): Promise<PlayerLocationRecord | null>;
  insertInitialLocation(playerId: PlayerId, areaId: string): Promise<boolean>;
  moveLocation(input: {
    readonly playerId: PlayerId;
    readonly destinationAreaId: string;
    readonly expectedRevision: bigint;
  }): Promise<PlayerLocationRecord | null>;
  area(contentReleaseId: string, areaId: string): Promise<WorldAreaRecord | null>;
  areasInRegion(contentReleaseId: string, regionId: string): Promise<readonly WorldAreaRecord[]>;
  connectionsFrom(
    contentReleaseId: string,
    areaId: string,
  ): Promise<readonly WorldConnectionRecord[]>;
  connectionBetween(
    contentReleaseId: string,
    fromAreaId: string,
    toAreaId: string,
  ): Promise<WorldConnectionRecord | null>;
  activeFlowState(playerId: PlayerId): Promise<WorldFlowState>;
  activeUnlockKeys(playerId: PlayerId): Promise<readonly string[]>;
}

export interface WorldRepository {
  transaction<T>(work: (transaction: WorldTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: WorldTransaction) => Promise<T>): Promise<T>;
}
