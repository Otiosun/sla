import type { PlayerId } from "../../shared-kernel/ids.js";
import type { Result } from "../../shared-kernel/result.js";
import type { WorldService } from "../world/service.js";
import {
  inspectExplorationWorld,
  type ExplorationWorldAdmission,
  type PublishedExplorationAreas,
} from "./expedition-world-admission.js";

/**
 * Read-only composition for the future /explorar preparation menu.
 * There is intentionally no route registration, quota debit or travel here.
 */
export class ExpeditionWorldPreview {
  public constructor(
    private readonly world: Pick<WorldService, "getLocation">,
    private readonly publishedAreas: {
      forActiveRelease(contentReleaseId: string): Promise<PublishedExplorationAreas | null>;
    },
  ) {}

  public async inspect(playerId: PlayerId): Promise<Result<ExplorationWorldAdmission>> {
    const world = await this.world.getLocation(playerId);
    if (!world.ok) return world;
    const publishedAreas = await this.publishedAreas.forActiveRelease(world.value.contentReleaseId);
    return inspectExplorationWorld({ playerId, location: world.value, publishedAreas });
  }
}
