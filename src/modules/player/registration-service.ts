import { randomUUID } from "node:crypto";
import { createPlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  ExternalIdentitySchema,
  ProfileInputSchema,
  RegionSelectionSchema,
  type ResolvePlayerResult,
} from "./contracts.js";
import {
  playerInvalidState,
  playerNotFound,
  playerRevisionConflict,
  playerValidationError,
} from "./errors.js";
import { onboardingHasReached, onboardingStateMachine } from "./onboarding-state.js";
import type { PlayerOnboardingRepository } from "./ports.js";

export class PlayerRegistrationService {
  public constructor(private readonly repository: PlayerOnboardingRepository) {}

  public async resolveOrCreatePlayer(identityInput: unknown): Promise<Result<ResolvePlayerResult>> {
    const parsed = ExternalIdentitySchema.safeParse(identityInput);
    if (!parsed.success)
      return err(playerValidationError("External identity", parsed.error.issues));
    const identity = parsed.data;

    return this.repository.transaction(async (transaction) => {
      await transaction.acquireIdentityLock(identity);
      const existingPlayerId = await transaction.findPlayerByIdentity(identity);
      if (existingPlayerId !== null) {
        const existing = await transaction.loadOnboarding(existingPlayerId, true);
        if (existing === null) return err(playerNotFound(existingPlayerId));
        return ok({ playerId: existingPlayerId, state: existing.state, created: false });
      }

      const context = await transaction.loadActiveContentContext();
      if (context === null) {
        return err(
          appError("FEATURE_UNAVAILABLE", "No published active content release is available"),
        );
      }
      const playerId = createPlayerId();
      await transaction.createPlayerFoundation({
        playerId,
        identityId: randomUUID(),
        identity,
        context,
      });
      return ok({ playerId, state: "NEW", created: true });
    });
  }

  public async createProfile(
    playerId: PlayerId,
    profileInput: unknown,
  ): Promise<Result<{ readonly playerId: PlayerId; readonly state: "PROFILE_CREATED" }>> {
    const parsed = ProfileInputSchema.safeParse(profileInput);
    if (!parsed.success) return err(playerValidationError("Trainer profile", parsed.error.issues));
    const profile = parsed.data;

    return this.repository.transaction(async (transaction) => {
      const onboarding = await transaction.loadOnboarding(playerId, true);
      if (onboarding === null) return err(playerNotFound(playerId));
      if (onboarding.state === "NEW") {
        const transition = onboardingStateMachine.transition("NEW", "PROFILE_CREATED");
        if (!transition.ok) return transition;
        const changed = await transaction.createProfile({
          playerId,
          profile,
          expectedRevision: onboarding.revision,
        });
        return changed ? ok({ playerId, state: "PROFILE_CREATED" }) : err(playerRevisionConflict());
      }

      if (onboardingHasReached(onboarding.state, "PROFILE_CREATED")) {
        const existing = await transaction.loadProfile(playerId);
        if (
          existing !== null &&
          existing.trainerName === profile.trainerName &&
          existing.locale === (profile.locale ?? null) &&
          Object.keys(existing.metadata).length === 0
        ) {
          return ok({ playerId, state: "PROFILE_CREATED" });
        }
        return err(appError("ACTION_INVALID", "Trainer profile already has different values"));
      }
      return err(playerInvalidState(onboarding, "NEW"));
    });
  }

  public async selectRegion(
    playerId: PlayerId,
    selectionInput: unknown,
  ): Promise<Result<{ readonly playerId: PlayerId; readonly state: "REGION_SELECTED" }>> {
    const parsed = RegionSelectionSchema.safeParse(selectionInput);
    if (!parsed.success) return err(playerValidationError("Region selection", parsed.error.issues));
    const { regionId } = parsed.data;

    return this.repository.transaction(async (transaction) => {
      const onboarding = await transaction.loadOnboarding(playerId, true);
      if (onboarding === null) return err(playerNotFound(playerId));
      if (onboarding.state === "PROFILE_CREATED") {
        if (!(await transaction.regionIsActive(onboarding.contentReleaseId, regionId))) {
          return err(
            appError("ACTION_INVALID", "Region is not active in the pinned content release"),
          );
        }
        const transition = onboardingStateMachine.transition("PROFILE_CREATED", "REGION_SELECTED");
        if (!transition.ok) return transition;
        const changed = await transaction.selectRegion({
          playerId,
          regionId,
          expectedRevision: onboarding.revision,
        });
        return changed ? ok({ playerId, state: "REGION_SELECTED" }) : err(playerRevisionConflict());
      }

      if (onboardingHasReached(onboarding.state, "REGION_SELECTED")) {
        return onboarding.originRegionId === regionId
          ? ok({ playerId, state: "REGION_SELECTED" })
          : err(appError("ACTION_INVALID", "A different origin region was already selected"));
      }
      return err(playerInvalidState(onboarding, "PROFILE_CREATED"));
    });
  }
}
