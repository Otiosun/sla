import type { ExternalIdentity } from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
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

export class PlayerPortalWorldService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly world: Pick<WorldService, "getLocation">,
  ) {}

  public async getLocation(
    identity: ExternalIdentity,
  ): Promise<Result<PlayerPortalWorldLocationView>> {
    const playerId = await this.repository.read((transaction) =>
      transaction.findPlayerByIdentity(identity),
    );
    if (playerId === null) {
      return err(appError("NOT_FOUND", "Player portal world unavailable"));
    }

    const location = await this.world.getLocation(playerId);
    if (!location.ok) return location;

    return ok({
      areaId: location.value.areaId,
      areaSlug: location.value.areaSlug,
      areaDisplayName: location.value.areaDisplayName,
      regionId: location.value.regionId,
      regionSlug: location.value.regionSlug,
      regionDisplayName: location.value.regionDisplayName,
      safePoint: location.value.safePoint,
      revision: location.value.revision.toString(),
      enteredAt: location.value.enteredAt.toISOString(),
      requiresRelocation: location.value.requiresRelocation,
      relocationAreaId: location.value.relocationAreaId,
      connections: location.value.connections.map((connection) => ({
        connectionId: connection.connectionId,
        connectionKey: connection.connectionKey,
        destinationAreaId: connection.destinationAreaId,
        destinationSlug: connection.destinationSlug,
        destinationDisplayName: connection.destinationDisplayName,
        available: connection.available,
        missingUnlockKeys: connection.missingUnlockKeys,
      })),
    });
  }
}
