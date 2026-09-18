import { ExternalIdentitySchema, type ExternalIdentity } from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
import type { WorldLocationView } from "../world/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface PlayerPortalLocationView {
  readonly areaId: string;
  readonly areaSlug: string;
  readonly areaDisplayName: string;
  readonly regionId: string;
  readonly regionSlug: string;
  readonly regionDisplayName: string;
  readonly safePoint: boolean;
  readonly enteredAt: string;
}

export interface PlayerPortalWorldLocationReader {
  getLocation(playerId: PlayerId): Promise<Result<WorldLocationView>>;
}

export class PlayerPortalLocationReadService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly world: PlayerPortalWorldLocationReader,
  ) {}

  public async getLocation(identity: ExternalIdentity): Promise<Result<PlayerPortalLocationView>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    const playerId = await this.repository.read(async (transaction) =>
      transaction.findPlayerByIdentity(parsedIdentity.data),
    );
    if (playerId === null) {
      return err(appError("NOT_FOUND", "Player portal profile unavailable"));
    }

    const location = await this.world.getLocation(playerId);
    if (!location.ok) return err(location.error);

    return ok({
      areaId: location.value.areaId,
      areaSlug: location.value.areaSlug,
      areaDisplayName: location.value.areaDisplayName,
      regionId: location.value.regionId,
      regionSlug: location.value.regionSlug,
      regionDisplayName: location.value.regionDisplayName,
      safePoint: location.value.safePoint,
      enteredAt: location.value.enteredAt.toISOString(),
    });
  }
}
