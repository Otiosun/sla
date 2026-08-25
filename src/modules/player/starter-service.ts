import { randomUUID } from "node:crypto";
import type { Clock } from "../../platform/clock/index.js";
import type { RandomSource } from "../../platform/rng/index.js";
import {
  createPokemonInstanceId,
  type CorrelationId,
  type PlayerId,
} from "../../shared-kernel/ids.js";
import { evaluateActionGate, type FeatureAvailability } from "../../shared-kernel/gates.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  StarterSelectionSchema,
  type PlayerProfileView,
  type StarterGrantResult,
  type StarterGrantWrite,
  type StarterOption,
  type StarterPreparationResult,
} from "./contracts.js";
import {
  playerInvalidState,
  playerNotFound,
  playerRevisionConflict,
  playerValidationError,
} from "./errors.js";
import { onboardingHasReached, onboardingStateMachine } from "./onboarding-state.js";
import type { PlayerOnboardingRepository } from "./ports.js";
import { generateStarter } from "./starter-generation.js";

export class PlayerStarterService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly clock: Clock,
    private readonly rng: RandomSource,
  ) {}

  public async prepareStarterSelection(
    playerId: PlayerId,
  ): Promise<Result<StarterPreparationResult>> {
    return this.repository.transaction(async (transaction) => {
      let onboarding = await transaction.loadOnboarding(playerId, true);
      if (onboarding === null) return err(playerNotFound(playerId));
      if (onboarding.originRegionId === null) {
        return err(playerInvalidState(onboarding, "REGION_SELECTED"));
      }

      const options = await transaction.listStarterOptions(
        onboarding.contentReleaseId,
        onboarding.originRegionId,
      );
      if (options.length === 0) {
        return err(appError("ACTION_INVALID", "No starter is configured for the selected region"));
      }

      if (onboarding.state === "REGION_SELECTED") {
        const transition = onboardingStateMachine.transition("REGION_SELECTED", "STARTER_PENDING");
        if (!transition.ok) return transition;
        const starterClaimKey = randomUUID();
        const changed = await transaction.setStarterPending({
          playerId,
          starterClaimKey,
          expectedRevision: onboarding.revision,
        });
        if (!changed) return err(playerRevisionConflict());
        onboarding = {
          ...onboarding,
          state: "STARTER_PENDING",
          starterClaimKey,
          revision: onboarding.revision + 1n,
        };
      } else if (!onboardingHasReached(onboarding.state, "STARTER_PENDING")) {
        return err(playerInvalidState(onboarding, "REGION_SELECTED"));
      }

      if (onboarding.starterClaimKey === null) {
        return err(appError("ACTION_INVALID", "Starter claim context is missing"));
      }
      return ok({ playerId, starterClaimKey: onboarding.starterClaimKey, options });
    });
  }

  public async listStarterOptions(playerId: PlayerId): Promise<Result<readonly StarterOption[]>> {
    return this.repository.read(async (transaction) => {
      const onboarding = await transaction.loadOnboarding(playerId);
      if (onboarding === null) return err(playerNotFound(playerId));
      if (onboarding.originRegionId === null) {
        return err(playerInvalidState(onboarding, "REGION_SELECTED"));
      }
      return ok(
        await transaction.listStarterOptions(onboarding.contentReleaseId, onboarding.originRegionId),
      );
    });
  }

  public async grantStarter(
    playerId: PlayerId,
    selectionInput: unknown,
    correlationId: CorrelationId | null = null,
  ): Promise<Result<StarterGrantResult>> {
    const parsed = StarterSelectionSchema.safeParse(selectionInput);
    if (!parsed.success) return err(playerValidationError("Starter selection", parsed.error.issues));
    const { formId } = parsed.data;

    return this.repository.transaction(async (transaction) => {
      const onboarding = await transaction.loadOnboarding(playerId, true);
      if (onboarding === null) return err(playerNotFound(playerId));
      const existing = await transaction.findStarterGrant(playerId);
      if (existing !== null) {
        if (existing.formId !== null && existing.formId !== formId) {
          return err(appError("ACTION_INVALID", "Player already claimed a different starter"));
        }
        return ok({
          playerId,
          pokemonInstanceId: existing.pokemonInstanceId,
          state: onboarding.state === "COMPLETE" ? "COMPLETE" : "STARTER_GRANTED",
          replayed: true,
        });
      }

      if (
        onboarding.state !== "STARTER_PENDING" ||
        onboarding.starterClaimKey === null ||
        onboarding.originRegionId === null
      ) {
        return err(playerInvalidState(onboarding, "STARTER_PENDING"));
      }

      const build = await transaction.loadStarterBuild({
        contentReleaseId: onboarding.contentReleaseId,
        rulesetId: onboarding.rulesetId,
        regionId: onboarding.originRegionId,
        formId,
      });
      if (build === null) {
        return err(
          appError("ACTION_INVALID", "Selected starter is not available in this onboarding release"),
        );
      }

      let generated;
      try {
        generated = generateStarter(build, this.rng);
      } catch (error) {
        return err(
          appError("VALIDATION_FAILED", "Starter content cannot produce a valid Pokémon", {
            reason: error instanceof Error ? error.message : "unknown starter generation error",
          }),
        );
      }

      const pokemonInstanceId = createPokemonInstanceId();
      const write: StarterGrantWrite = {
        grantId: randomUUID(),
        historyEventId: randomUUID(),
        playerId,
        pokemonInstanceId,
        regionId: onboarding.originRegionId,
        formId,
        idempotencyKey: onboarding.starterClaimKey,
        contentReleaseId: onboarding.contentReleaseId,
        rulesetId: onboarding.rulesetId,
        correlationId,
        generated,
        placement: await transaction.nextRosterPlacement(playerId),
        expectedOnboardingRevision: onboarding.revision,
      };
      const changed = await transaction.createStarterBundle(write);
      if (!changed) return err(playerRevisionConflict());
      return ok({ playerId, pokemonInstanceId, state: "STARTER_GRANTED", replayed: false });
    });
  }

  public async completeOnboarding(
    playerId: PlayerId,
  ): Promise<Result<{ readonly playerId: PlayerId; readonly state: "COMPLETE" }>> {
    return this.repository.transaction(async (transaction) => {
      const onboarding = await transaction.loadOnboarding(playerId, true);
      if (onboarding === null) return err(playerNotFound(playerId));
      if (onboarding.state === "COMPLETE") return ok({ playerId, state: "COMPLETE" });
      if (onboarding.state !== "STARTER_GRANTED") {
        return err(playerInvalidState(onboarding, "STARTER_GRANTED"));
      }
      if ((await transaction.findStarterGrant(playerId)) === null) {
        return err(appError("ACTION_INVALID", "Cannot complete onboarding without a durable starter grant"));
      }
      const transition = onboardingStateMachine.transition("STARTER_GRANTED", "COMPLETE");
      if (!transition.ok) return transition;
      const changed = await transaction.completeOnboarding({
        playerId,
        completedAt: this.clock.now(),
        expectedRevision: onboarding.revision,
      });
      return changed ? ok({ playerId, state: "COMPLETE" }) : err(playerRevisionConflict());
    });
  }

  public async getProfile(playerId: PlayerId): Promise<Result<PlayerProfileView>> {
    return this.repository.read(async (transaction) => {
      const profile = await transaction.loadProfileView(playerId);
      return profile === null ? err(playerNotFound(playerId)) : ok(profile);
    });
  }

  public async evaluateGameplayAccess(
    playerId: PlayerId,
    feature: FeatureAvailability,
  ): Promise<Result<void>> {
    return this.repository.read(async (transaction) => {
      const profile = await transaction.loadProfileView(playerId);
      if (profile === null) return err(playerNotFound(playerId));
      return evaluateActionGate({
        feature,
        player: {
          eligible: profile.playerStatus === "ACTIVE",
          reason: profile.playerStatus === "ACTIVE" ? null : `player-status:${profile.playerStatus}`,
        },
        flow: {
          state: profile.onboardingState,
          allowsAction: profile.onboardingState === "COMPLETE",
          reason: profile.onboardingState === "COMPLETE" ? null : "onboarding-incomplete",
        },
        action: { valid: true, reason: null },
      });
    });
  }
}
