import type { ConnectionAccessRule, WorldAreaConfig } from "../catalog/world-contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";

export interface WorldAreaRecord {
  readonly areaId: string;
  readonly areaSlug: string;
  readonly areaDisplayName: string;
  readonly regionId: string;
  readonly regionSlug: string;
  readonly regionDisplayName: string;
  readonly active: boolean;
  readonly config: WorldAreaConfig;
}

export interface WorldConnectionRecord {
  readonly connectionId: string;
  readonly connectionKey: string;
  readonly fromAreaId: string;
  readonly toAreaId: string;
  readonly active: boolean;
  readonly accessRule: ConnectionAccessRule;
}

export interface PlayerLocationRecord {
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly enteredAt: Date;
  readonly revision: bigint;
}

export interface WorldFlowState {
  readonly encounterActive: boolean;
  readonly battleActive: boolean;
}

export interface WorldPlayerEligibility {
  readonly playerActive: boolean;
  readonly onboardingComplete: boolean;
  readonly originRegionId: string | null;
}

export interface WorldConnectionView {
  readonly connectionId: string;
  readonly connectionKey: string;
  readonly destinationAreaId: string;
  readonly destinationSlug: string;
  readonly destinationDisplayName: string;
  readonly available: boolean;
  readonly missingUnlockKeys: readonly string[];
}

export interface WorldLocationView {
  readonly playerId: PlayerId;
  readonly contentReleaseId: string;
  readonly areaId: string;
  readonly areaSlug: string;
  readonly areaDisplayName: string;
  readonly regionId: string;
  readonly regionSlug: string;
  readonly regionDisplayName: string;
  readonly safePoint: boolean;
  readonly revision: bigint;
  readonly enteredAt: Date;
  readonly requiresRelocation: boolean;
  readonly relocationAreaId: string | null;
  readonly connections: readonly WorldConnectionView[];
}

export interface TravelResult {
  readonly from: WorldLocationView;
  readonly to: WorldLocationView;
  readonly replayed: boolean;
}

export interface WorldTravelReceipt {
  readonly idempotencyKey: string;
  readonly playerId: PlayerId;
  readonly destinationAreaId: string;
  readonly expectedRevision: bigint;
  readonly resultingRevision: bigint;
  readonly from: WorldLocationView;
  readonly to: WorldLocationView;
}

export interface EnsureInitialLocationInput {
  readonly playerId: PlayerId;
}

export interface TravelInput {
  readonly playerId: PlayerId;
  readonly destinationAreaId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
}

export interface RelocateInput {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
}
