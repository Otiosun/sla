import {
  ExternalIdentitySchema,
  type ExternalIdentity,
  type PlayerProfileView,
} from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export type PlayerPortalSelfView = Omit<PlayerProfileView, "progressionPoints"> & {
  readonly progressionPoints: string;
};

export class PlayerPortalReadService {
  public constructor(private readonly repository: PlayerOnboardingRepository) {}

  public async getSelf(identity: ExternalIdentity): Promise<Result<PlayerPortalSelfView>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    return this.repository.read(async (transaction) => {
      const playerId = await transaction.findPlayerByIdentity(parsedIdentity.data);
      if (playerId === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }

      const profile = await transaction.loadProfileView(playerId);
      if (profile === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }
      if (profile.playerStatus !== "ACTIVE") {
        return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
      }

      return ok({
        ...profile,
        progressionPoints: profile.progressionPoints.toString(),
      });
    });
  }
}
