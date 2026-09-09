import type { ExternalIdentity } from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
import type { WorldLocationView } from "../world/contracts.js";
import type { WorldService } from "../world/service.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface PlayerPortalWorldConnectionView {
  readonly connectionId: string;
  readonly connectionKey: string;
  readonly destinationAreaId: string;
  readonly destinationSlug: string;
  readonly destinationDisplayName: string;
  readonly available: boolean;
  readonly missingUnlockKeys: readonly string[];
}

export interface PlayerPortalWorldLocationView {
  readonly areaId: string;
  readonly areaSlug: string;
  readonly areaDisplayName: string;
  readonly regionId: string;
  readonly regionSlug: string;
  readonly regionDisplayName: string;
  readonly safePoint: boolean;
  readonly revision: string;
  readonly enteredAt: string;
  readonly requiresRelocation: boolean;
  readonly relocationAreaId: string | null;
  readonly connections: readonly PlayerPortalWorldConnectionView[];
}

export interface PlayerPortalWorldTravelInput {
  readonly destinationAreaId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
}

export interface PlayerPortalWorldTravelView {
  readonly from: PlayerPortalWorldLocationView;
  readonly to: PlayerPortalWorldLocationView;
  readonly replayed: boolean;
}

export class PlayerPortalWorldService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly world: Pick<WorldService, "getLocation" | "travel">,
  ) {}

  public async getLocation(
    identity: ExternalIdentity,
  ): Promise<Result<PlayerPortalWorldLocationView>> {
    const playerId = await this.resolvePlayerId(identity);
    if (!playerId.ok) return playerId;

    const location = await this.world.getLocation(playerId.value);
    if (!location.ok) return location;

    return ok(mapLocation(location.value));
  }

  public async travel(
    identity: ExternalIdentity,
    input: PlayerPortalWorldTravelInput,
  ): Promise<Result<PlayerPortalWorldTravelView>> {
    if (!/^\d+$/.test(input.expectedRevision)) {
      return err(appError("VALIDATION_FAILED", "Invalid world revision"));
    }

    const playerId = await this.resolvePlayerId(identity);
    if (!playerId.ok) return playerId;

    const traveled = await this.world.travel({
      playerId: playerId.value,
      destinationAreaId: input.destinationAreaId,
      expectedRevision: BigInt(input.expectedRevision),
      idempotencyKey: input.idempotencyKey,
    });
    if (!traveled.ok) return traveled;

    return ok({
      from: mapLocation(traveled.value.from),
      to: mapLocation(traveled.value.to),
      replayed: traveled.value.replayed,
    });
  }

  private async resolvePlayerId(identity: ExternalIdentity) {
    const playerId = await this.repository.read((transaction) =>
      transaction.findPlayerByIdentity(identity),
    );
    if (playerId === null) {
      return err(appError("NOT_FOUND", "Player portal world unavailable"));
    }
    return ok(playerId);
  }
}

function mapLocation(location: WorldLocationView): PlayerPortalWorldLocationView {
  return {
    areaId: location.areaId,
    areaSlug: location.areaSlug,
    areaDisplayName: location.areaDisplayName,
    regionId: location.regionId,
    regionSlug: location.regionSlug,
    regionDisplayName: location.regionDisplayName,
    safePoint: location.safePoint,
    revision: location.revision.toString(),
    enteredAt: location.enteredAt.toISOString(),
    requiresRelocation: location.requiresRelocation,
    relocationAreaId: location.relocationAreaId,
    connections: location.connections.map((connection) => ({
      connectionId: connection.connectionId,
      connectionKey: connection.connectionKey,
      destinationAreaId: connection.destinationAreaId,
      destinationSlug: connection.destinationSlug,
      destinationDisplayName: connection.destinationDisplayName,
      available: connection.available,
      missingUnlockKeys: connection.missingUnlockKeys,
    })),
  };
}
