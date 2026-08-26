import { z } from "zod";
import {
  evaluateActionGate,
  type FeatureAvailability,
  type FlowState,
  type PlayerEligibility,
} from "../../shared-kernel/gates.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  EnsureInitialLocationInput,
  PlayerLocationRecord,
  RelocateInput,
  TravelInput,
  TravelResult,
  WorldAreaRecord,
  WorldConnectionView,
  WorldLocationView,
  WorldPlayerEligibility,
} from "./contracts.js";
import {
  locationRevisionConflict,
  relocationRequired,
  worldNotReady,
  worldValidationError,
} from "./errors.js";
import type { WorldRepository, WorldTransaction } from "./ports.js";

const uuidSchema = z.string().uuid();

function playerGate(eligibility: WorldPlayerEligibility): PlayerEligibility {
  if (!eligibility.playerActive) {
    return { eligible: false, reason: "player-not-active" };
  }
  if (!eligibility.onboardingComplete) {
    return { eligible: false, reason: "onboarding-incomplete" };
  }
  return { eligible: true, reason: null };
}

function flowGate(encounterActive: boolean, battleActive: boolean): FlowState {
  if (encounterActive || battleActive) {
    return {
      state: battleActive ? "BATTLE_ACTIVE" : "ENCOUNTER_ACTIVE",
      allowsAction: false,
      reason: battleActive ? "active-battle" : "active-encounter",
    };
  }
  return { state: "FREE", allowsAction: true, reason: null };
}

function missingUnlockKeys(required: readonly string[], owned: ReadonlySet<string>): readonly string[] {
  return required.filter((key) => !owned.has(key));
}

function chooseRelocationArea(areas: readonly WorldAreaRecord[]): WorldAreaRecord | null {
  const candidates = areas
    .filter((area) => area.active && area.config.safePoint)
    .sort(
      (left, right) =>
        left.config.relocationPriority - right.config.relocationPriority ||
        left.areaId.localeCompare(right.areaId),
    );
  return candidates[0] ?? null;
}

export class WorldService {
  public constructor(
    private readonly repository: WorldRepository,
    private readonly feature: FeatureAvailability,
  ) {}

  public async ensureInitialLocation(
    input: EnsureInitialLocationInput,
  ): Promise<Result<WorldLocationView>> {
    return this.repository.transaction(async (transaction) => {
      const base = await this.loadBase(transaction, input.playerId);
      if (!base.ok) return base;

      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(base.value.eligibility),
        flow: { state: "INITIALIZATION", allowsAction: true, reason: null },
        action: {
          valid: base.value.eligibility.originRegionId !== null,
          reason: base.value.eligibility.originRegionId === null ? "origin-region-missing" : null,
        },
      });
      if (!gate.ok) return gate;

      const existing = await transaction.playerLocation(input.playerId, true);
      if (existing !== null) {
        return this.buildView(transaction, base.value.contentReleaseId, existing);
      }

      const regionId = base.value.eligibility.originRegionId;
      if (regionId === null) return err(worldNotReady("Player origin region is missing"));
      const areas = await transaction.areasInRegion(base.value.contentReleaseId, regionId);
      const starting = areas.filter((area) => area.active && area.config.startingArea);
      if (starting.length !== 1) {
        return err(
          worldNotReady("Active content release must define exactly one starting area for the region"),
        );
      }

      await transaction.insertInitialLocation(input.playerId, starting[0]?.areaId ?? "");
      const created = await transaction.playerLocation(input.playerId, true);
      if (created === null) return err(worldNotReady("Player location could not be initialized"));
      return this.buildView(transaction, base.value.contentReleaseId, created);
    });
  }

  public async getLocation(playerId: PlayerId): Promise<Result<WorldLocationView>> {
    return this.repository.read(async (transaction) => {
      const base = await this.loadBase(transaction, playerId);
      if (!base.ok) return base;
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(base.value.eligibility),
        flow: { state: "READ", allowsAction: true, reason: null },
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;

      const location = await transaction.playerLocation(playerId);
      if (location === null) return err(worldNotReady("Player location is not initialized"));
      return this.buildView(transaction, base.value.contentReleaseId, location);
    });
  }

  public async travel(input: TravelInput): Promise<Result<TravelResult>> {
    if (!uuidSchema.safeParse(input.destinationAreaId).success) {
      return err(worldValidationError("destinationAreaId must be a UUID"));
    }
    if (input.expectedRevision < 0n) {
      return err(worldValidationError("expectedRevision must be non-negative"));
    }

    return this.repository.transaction(async (transaction) => {
      const base = await this.loadBase(transaction, input.playerId);
      if (!base.ok) return base;
      const location = await transaction.playerLocation(input.playerId, true);
      if (location === null) return err(worldNotReady("Player location is not initialized"));
      if (location.revision !== input.expectedRevision) {
        return err(locationRevisionConflict(input.expectedRevision));
      }

      const currentArea = await transaction.area(base.value.contentReleaseId, location.areaId);
      if (currentArea === null) {
        return err(worldNotReady("Current area is absent from the active content release"));
      }
      if (!currentArea.active) {
        const relocation = chooseRelocationArea(
          await transaction.areasInRegion(base.value.contentReleaseId, currentArea.regionId),
        );
        return err(relocationRequired(currentArea.areaId, relocation?.areaId ?? null));
      }

      const destination = await transaction.area(
        base.value.contentReleaseId,
        input.destinationAreaId,
      );
      const connection = await transaction.connectionBetween(
        base.value.contentReleaseId,
        currentArea.areaId,
        input.destinationAreaId,
      );
      const flow = await transaction.activeFlowState(input.playerId);
      const unlockKeys = new Set(await transaction.activeUnlockKeys(input.playerId));
      const missing =
        connection === null ? [] : missingUnlockKeys(connection.accessRule.requiredUnlockKeys, unlockKeys);
      const actionValid =
        destination !== null && destination.active && connection !== null && connection.active && missing.length === 0;
      const actionReason =
        destination === null
          ? "destination-missing"
          : !destination.active
            ? "destination-inactive"
            : connection === null
              ? "connection-missing"
              : !connection.active
                ? "connection-inactive"
                : missing.length > 0
                  ? `missing-unlocks:${missing.join(",")}`
                  : null;

      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(base.value.eligibility),
        flow: flowGate(flow.encounterActive, flow.battleActive),
        action: { valid: actionValid, reason: actionReason },
      });
      if (!gate.ok) return gate;

      const from = await this.buildView(transaction, base.value.contentReleaseId, location);
      if (!from.ok) return from;
      const moved = await transaction.moveLocation({
        playerId: input.playerId,
        destinationAreaId: input.destinationAreaId,
        expectedRevision: input.expectedRevision,
      });
      if (moved === null) return err(locationRevisionConflict(input.expectedRevision));
      const to = await this.buildView(transaction, base.value.contentReleaseId, moved);
      if (!to.ok) return to;
      return ok({ from: from.value, to: to.value });
    });
  }

  public async relocate(input: RelocateInput): Promise<Result<WorldLocationView>> {
    if (input.expectedRevision < 0n) {
      return err(worldValidationError("expectedRevision must be non-negative"));
    }

    return this.repository.transaction(async (transaction) => {
      const base = await this.loadBase(transaction, input.playerId);
      if (!base.ok) return base;
      const location = await transaction.playerLocation(input.playerId, true);
      if (location === null) return err(worldNotReady("Player location is not initialized"));
      if (location.revision !== input.expectedRevision) {
        return err(locationRevisionConflict(input.expectedRevision));
      }

      const currentArea = await transaction.area(base.value.contentReleaseId, location.areaId);
      if (currentArea === null) {
        return err(worldNotReady("Current area is absent from the active content release"));
      }
      if (currentArea.active) {
        return err(worldValidationError("Relocation is allowed only from an inactive area"));
      }

      const flow = await transaction.activeFlowState(input.playerId);
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(base.value.eligibility),
        flow: flowGate(flow.encounterActive, flow.battleActive),
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;

      const relocation = chooseRelocationArea(
        await transaction.areasInRegion(base.value.contentReleaseId, currentArea.regionId),
      );
      if (relocation === null) {
        return err(worldNotReady("No active safe relocation area exists in the current region"));
      }
      const moved = await transaction.moveLocation({
        playerId: input.playerId,
        destinationAreaId: relocation.areaId,
        expectedRevision: input.expectedRevision,
      });
      if (moved === null) return err(locationRevisionConflict(input.expectedRevision));
      return this.buildView(transaction, base.value.contentReleaseId, moved);
    });
  }

  private async loadBase(
    transaction: WorldTransaction,
    playerId: PlayerId,
  ): Promise<
    Result<{ readonly contentReleaseId: string; readonly eligibility: WorldPlayerEligibility }>
  > {
    const contentReleaseId = await transaction.activeContentReleaseId();
    if (contentReleaseId === null) return err(worldNotReady("No active content release exists"));
    const eligibility = await transaction.playerEligibility(playerId);
    if (eligibility === null) return err(worldNotReady("Player does not exist"));
    return ok({ contentReleaseId, eligibility });
  }

  private async buildView(
    transaction: WorldTransaction,
    contentReleaseId: string,
    location: PlayerLocationRecord,
  ): Promise<Result<WorldLocationView>> {
    const area = await transaction.area(contentReleaseId, location.areaId);
    if (area === null) {
      return err(worldNotReady("Player area is absent from the active content release"));
    }

    const regionAreas = await transaction.areasInRegion(contentReleaseId, area.regionId);
    const relocation = area.active ? null : chooseRelocationArea(regionAreas);
    const unlockKeys = new Set(await transaction.activeUnlockKeys(location.playerId));
    const views: WorldConnectionView[] = [];
    if (area.active) {
      const connections = await transaction.connectionsFrom(contentReleaseId, area.areaId);
      for (const connection of connections) {
        if (!connection.active) continue;
        const destination = await transaction.area(contentReleaseId, connection.toAreaId);
        if (destination === null || !destination.active) continue;
        const missing = missingUnlockKeys(connection.accessRule.requiredUnlockKeys, unlockKeys);
        views.push({
          connectionId: connection.connectionId,
          connectionKey: connection.connectionKey,
          destinationAreaId: destination.areaId,
          destinationSlug: destination.areaSlug,
          destinationDisplayName: destination.areaDisplayName,
          available: missing.length === 0,
          missingUnlockKeys: missing,
        });
      }
    }

    return ok({
      playerId: location.playerId,
      contentReleaseId,
      areaId: area.areaId,
      areaSlug: area.areaSlug,
      areaDisplayName: area.areaDisplayName,
      regionId: area.regionId,
      regionSlug: area.regionSlug,
      regionDisplayName: area.regionDisplayName,
      safePoint: area.config.safePoint,
      revision: location.revision,
      enteredAt: location.enteredAt,
      requiresRelocation: !area.active,
      relocationAreaId: relocation?.areaId ?? null,
      connections: views.sort((left, right) => left.connectionKey.localeCompare(right.connectionKey)),
    });
  }
}
