import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationRepository, RegistrationRevisionRecord } from "./ports.js";
import type { PlayerAccessRecord, PlayerAccessRepository } from "./player-access-ports.js";

interface MechanicalRegistrationPort {
  createProfile(
    playerId: PlayerId,
    input: { readonly trainerName: string },
  ): Promise<Result<unknown>>;
  selectRegion(playerId: PlayerId, input: { readonly regionId: string }): Promise<Result<unknown>>;
}

interface MechanicalStarterPort {
  prepareStarterSelection(playerId: PlayerId): Promise<Result<unknown>>;
  grantStarter(playerId: PlayerId, input: { readonly formId: string }): Promise<Result<unknown>>;
  completeOnboarding(playerId: PlayerId): Promise<Result<unknown>>;
}

interface MechanicalWorldPort {
  ensureInitialLocation(input: { readonly playerId: PlayerId }): Promise<Result<unknown>>;
}

function invalidState(message: string): Result<never> {
  return err(appError("INVALID_STATE_TRANSITION", message));
}

function revisionConflict(message: string): Result<never> {
  return err(appError("REVISION_CONFLICT", message));
}

export class PlayerProvisioningService {
  public constructor(
    private readonly registrationRepository: RegistrationRepository,
    private readonly accessRepository: PlayerAccessRepository,
    private readonly playerRegistration: MechanicalRegistrationPort,
    private readonly playerStarter: MechanicalStarterPort,
    private readonly world: MechanicalWorldPort,
  ) {}

  public async provisionApprovedPlayer(reviewId: string): Promise<Result<PlayerAccessRecord>> {
    const review = await this.registrationRepository.read((tx) => tx.loadRevisionById(reviewId));
    if (review === null) {
      return err(appError("NOT_FOUND", "Registration review was not found"));
    }
    if (review.status !== "APPROVED") {
      return invalidState("Only an approved registration review can provision a player");
    }

    const access = await this.ensureProvisioning(review);
    if (!access.ok) return access;
    if (access.value.status === "ACTIVE") return access;

    const profile = await this.playerRegistration.createProfile(review.playerId, {
      trainerName: review.snapshot.trainerName,
    });
    if (!profile.ok) return profile;

    const region = await this.playerRegistration.selectRegion(review.playerId, {
      regionId: review.snapshot.regionId,
    });
    if (!region.ok) return region;

    const prepared = await this.playerStarter.prepareStarterSelection(review.playerId);
    if (!prepared.ok) return prepared;

    const starter = await this.playerStarter.grantStarter(review.playerId, {
      formId: review.snapshot.starterFormId,
    });
    if (!starter.ok) return starter;

    const completed = await this.playerStarter.completeOnboarding(review.playerId);
    if (!completed.ok) return completed;

    const location = await this.world.ensureInitialLocation({ playerId: review.playerId });
    if (!location.ok) return location;

    return this.activate(review, access.value);
  }

  public async suspend(
    playerId: PlayerId,
    expectedRevision: number,
  ): Promise<Result<PlayerAccessRecord>> {
    return this.accessRepository.transaction(async (tx) => {
      const current = await tx.load(playerId);
      if (current.status !== "ACTIVE") {
        return invalidState("Only ACTIVE player access can be suspended");
      }
      const updated = await tx.suspend({ playerId, expectedRevision });
      return updated === null
        ? revisionConflict("Player access changed before suspension")
        : ok(updated);
    });
  }

  public async restore(
    playerId: PlayerId,
    expectedRevision: number,
  ): Promise<Result<PlayerAccessRecord>> {
    return this.accessRepository.transaction(async (tx) => {
      const current = await tx.load(playerId);
      if (current.status !== "SUSPENDED") {
        return invalidState("Only SUSPENDED player access can be restored");
      }
      const updated = await tx.restore({ playerId, expectedRevision });
      return updated === null
        ? revisionConflict("Player access changed before restoration")
        : ok(updated);
    });
  }

  private async ensureProvisioning(
    review: RegistrationRevisionRecord,
  ): Promise<Result<PlayerAccessRecord>> {
    return this.accessRepository.transaction(async (tx) => {
      const current = await tx.load(review.playerId);

      if (current.status === "ACTIVE") {
        return current.approvedReviewId === review.id
          ? ok(current)
          : invalidState("Player is already active for a different registration review");
      }
      if (current.status === "SUSPENDED") {
        return invalidState("Suspended player access must be restored explicitly");
      }
      if (current.status === "PROVISIONING") {
        return current.approvedReviewId === review.id
          ? ok(current)
          : invalidState("Player is already provisioning a different registration review");
      }

      const started = await tx.beginProvisioning({
        playerId: review.playerId,
        reviewId: review.id,
        expectedRevision: current.revision,
      });
      if (started !== null) return ok(started);

      const reloaded = await tx.load(review.playerId);
      if (reloaded.status === "PROVISIONING" && reloaded.approvedReviewId === review.id) {
        return ok(reloaded);
      }
      if (reloaded.status === "ACTIVE" && reloaded.approvedReviewId === review.id) {
        return ok(reloaded);
      }
      return revisionConflict("Player access changed before provisioning could start");
    });
  }

  private async activate(
    review: RegistrationRevisionRecord,
    provisioning: PlayerAccessRecord,
  ): Promise<Result<PlayerAccessRecord>> {
    return this.accessRepository.transaction(async (tx) => {
      const activated = await tx.activate({
        playerId: review.playerId,
        reviewId: review.id,
        expectedRevision: provisioning.revision,
      });
      if (activated !== null) return ok(activated);

      const current = await tx.load(review.playerId);
      if (current.status === "ACTIVE" && current.approvedReviewId === review.id) {
        return ok(current);
      }
      return revisionConflict("Player access changed before activation");
    });
  }
}
