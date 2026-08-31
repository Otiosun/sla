import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../platform/clock/index.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { BattleState } from "../battle/contracts.js";
import type { BattleTurnWindow } from "../battle/turn-window.js";
import type { EncounterSeedProvider } from "../encounter/ports.js";
import {
  acceptPvpChallenge,
  canonicalPvpChallengeCreationKey,
  createPvpChallenge,
  expirePvpChallenge,
  type PvpChallenge,
  type PvpFormatKey,
  type PvpReachPolicy,
} from "./challenge.js";
import {
  mapPvpChallengeError,
  pvpActionInvalid,
  pvpFlowBlocked,
  pvpPlayerIneligible,
} from "./errors.js";
import type {
  PvpChallengeRepository,
  PvpPlayerContext,
  PvpRecoveryRepository,
  PvpStartRepository,
  PvpStartRepositoryOutput,
  PvpTurnResolver,
} from "./ports.js";

const uuid = z.string().uuid();

export interface PvpServiceConfig {
  readonly challengeTtlMs: number;
  readonly turnWindowTtlMs?: number;
}

export interface CreatePvpChallengeRequest {
  readonly challengerPlayerId: string;
  readonly targetPlayerId: string;
  readonly formatKey: PvpFormatKey;
  readonly reachPolicy: PvpReachPolicy;
  readonly idempotencyKey: string;
}

export interface AcceptPvpChallengeRequest {
  readonly challengeId: string;
  readonly actorPlayerId: string;
}

export interface StartPvpEncounterRequest {
  readonly challengeId: string;
  readonly actorPlayerId: string;
}

export interface RecoverPvpEncounterRequest {
  readonly playerId: string;
}

export interface CreatePvpChallengeOutput {
  readonly challenge: PvpChallenge;
  readonly replayed: boolean;
}

export interface AcceptPvpChallengeOutput {
  readonly challenge: PvpChallenge;
  readonly encounterId: string;
  readonly replayed: boolean;
}

export type StartPvpEncounterOutput = PvpStartRepositoryOutput;

export interface RecoverPvpEncounterOutput {
  readonly battleId: string;
  readonly state: BattleState;
  readonly turnWindow: BattleTurnWindow | null;
  readonly resolvedLocked: boolean;
}

function playerEligibilityError(context: PvpPlayerContext): ReturnType<typeof appError> | null {
  if (!context.playerActive) return pvpPlayerIneligible("player-not-active", context.playerId);
  if (!context.onboardingComplete) {
    return pvpPlayerIneligible("onboarding-incomplete", context.playerId);
  }
  if (!context.activeExternalIdentity) {
    return pvpPlayerIneligible("external-identity-missing", context.playerId);
  }
  if (context.areaId === null) {
    return pvpPlayerIneligible("player-location-missing", context.playerId);
  }
  if (!context.hasEligibleTeamPokemon) {
    return pvpPlayerIneligible("battle-ready-team-missing", context.playerId);
  }
  return null;
}

function playerContextById(
  contexts: readonly PvpPlayerContext[],
  playerId: string,
): PvpPlayerContext | null {
  return contexts.find((context) => context.playerId === playerId) ?? null;
}

function exactCreateReplay(
  existing: PvpChallenge,
  input: CreatePvpChallengeRequest,
): Result<CreatePvpChallengeOutput> {
  if (
    existing.targetPlayerId !== input.targetPlayerId ||
    existing.formatKey !== input.formatKey ||
    existing.reachPolicy !== input.reachPolicy
  ) {
    return err(
      appError(
        "FINGERPRINT_MISMATCH",
        "Challenge idempotency key was already used for a different request",
      ),
    );
  }
  return ok({ challenge: existing, replayed: true });
}

export class PvpService {
  public constructor(
    private readonly repository: PvpChallengeRepository,
    private readonly seedProvider: EncounterSeedProvider,
    private readonly clock: Clock,
    private readonly feature: FeatureAvailability,
    private readonly config: PvpServiceConfig,
    private readonly startRepository?: PvpStartRepository,
    private readonly recoveryRepository?: PvpRecoveryRepository,
    private readonly turnResolver?: PvpTurnResolver,
  ) {
    if (!Number.isSafeInteger(config.challengeTtlMs) || config.challengeTtlMs <= 0) {
      throw new Error("PVP challenge TTL must be a positive safe integer");
    }
    if (
      config.turnWindowTtlMs !== undefined &&
      (!Number.isSafeInteger(config.turnWindowTtlMs) || config.turnWindowTtlMs <= 0)
    ) {
      throw new Error("PVP TurnWindow TTL must be a positive safe integer");
    }
  }

  public async createChallenge(
    input: CreatePvpChallengeRequest,
  ): Promise<Result<CreatePvpChallengeOutput>> {
    const feature = this.featureError();
    if (feature !== null) return err(feature);
    if (
      !uuid.safeParse(input.challengerPlayerId).success ||
      !uuid.safeParse(input.targetPlayerId).success
    ) {
      return err(appError("INVALID_ID", "PVP player ids must be valid UUIDs"));
    }
    if (input.challengerPlayerId === input.targetPlayerId) {
      return err(pvpActionInvalid("self-challenge"));
    }

    const canonicalKey = canonicalPvpChallengeCreationKey(input.idempotencyKey);
    if (!canonicalKey.ok) return err(mapPvpChallengeError(canonicalKey.error));

    return this.repository.transaction(async (transaction) => {
      const existing = await transaction.challengeByCreationKey(
        input.challengerPlayerId,
        canonicalKey.value,
        true,
      );
      if (existing !== null) return exactCreateReplay(existing, input);

      const content = await transaction.activeContent();
      if (content === null) return err(pvpFlowBlocked("active-content-missing"));

      const contexts = await transaction.playerContexts(
        [input.challengerPlayerId, input.targetPlayerId],
        true,
        content.contentReleaseId,
      );
      const challenger = playerContextById(contexts, input.challengerPlayerId);
      const target = playerContextById(contexts, input.targetPlayerId);
      const contextError = this.validatePlayers(challenger, target);
      if (contextError !== null) return err(contextError);
      if (challenger === null || target === null) {
        return err(
          pvpPlayerIneligible(
            "player-not-found",
            challenger === null ? input.challengerPlayerId : input.targetPlayerId,
          ),
        );
      }
      if (challenger.areaId === null || target.areaId === null) {
        return err(
          pvpPlayerIneligible(
            "player-location-missing",
            challenger.areaId === null ? challenger.playerId : target.playerId,
          ),
        );
      }
      if (challenger.areaId !== target.areaId) {
        return err(pvpActionInvalid("pvp-same-area-required"));
      }
      if (
        challenger.activeEncounter ||
        target.activeEncounter ||
        challenger.activeBattle ||
        target.activeBattle
      ) {
        return err(pvpFlowBlocked("active-mechanical-flow"));
      }

      const now = this.clock.now();
      const created = createPvpChallenge({
        id: randomUUID(),
        challengerPlayerId: input.challengerPlayerId,
        targetPlayerId: input.targetPlayerId,
        formatKey: input.formatKey,
        reachPolicy: input.reachPolicy,
        areaId: challenger.areaId,
        contentReleaseId: content.contentReleaseId,
        rulesetId: content.rulesetId,
        creationIdempotencyKey: input.idempotencyKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.config.challengeTtlMs),
      });
      if (!created.ok) return err(mapPvpChallengeError(created.error));

      if (await transaction.insertChallenge(created.value)) {
        return ok({ challenge: created.value, replayed: false });
      }

      const replay = await transaction.challengeByCreationKey(
        input.challengerPlayerId,
        canonicalKey.value,
        true,
      );
      return replay === null
        ? err(pvpFlowBlocked("challenge-already-open"))
        : exactCreateReplay(replay, input);
    });
  }

  public async acceptChallenge(
    input: AcceptPvpChallengeRequest,
  ): Promise<Result<AcceptPvpChallengeOutput>> {
    const feature = this.featureError();
    if (feature !== null) return err(feature);
    if (
      !uuid.safeParse(input.challengeId).success ||
      !uuid.safeParse(input.actorPlayerId).success
    ) {
      return err(appError("INVALID_ID", "PVP challenge and actor ids must be valid UUIDs"));
    }

    return this.repository.transaction(async (transaction) => {
      const challenge = await transaction.challengeById(input.challengeId, true);
      if (challenge === null) {
        return err(
          appError("NOT_FOUND", "PVP challenge was not found", { challengeId: input.challengeId }),
        );
      }
      if (input.actorPlayerId !== challenge.targetPlayerId) {
        return err(pvpActionInvalid("challenge-actor-forbidden"));
      }
      if (challenge.status === "ACCEPTED" && challenge.encounterId !== null) {
        return ok({
          challenge,
          encounterId: challenge.encounterId,
          replayed: true,
        });
      }
      if (challenge.status !== "OPEN") return err(pvpFlowBlocked("challenge-not-open"));

      const now = this.clock.now();
      if (now.getTime() >= Date.parse(challenge.expiresAt)) {
        const expired = expirePvpChallenge(challenge, now);
        if (!expired.ok) return err(mapPvpChallengeError(expired.error));
        if (
          !(await transaction.replaceChallenge({
            expectedRevision: challenge.revision,
            next: expired.value,
          }))
        ) {
          return err(appError("REVISION_CONFLICT", "PVP challenge expiry lost a revision race"));
        }
        return err(pvpFlowBlocked("challenge-expired"));
      }

      const contexts = await transaction.playerContexts(
        [challenge.challengerPlayerId, challenge.targetPlayerId],
        true,
        challenge.contentReleaseId,
      );
      const challenger = playerContextById(contexts, challenge.challengerPlayerId);
      const target = playerContextById(contexts, challenge.targetPlayerId);
      const contextError = this.validatePlayers(challenger, target);
      if (contextError !== null) return err(contextError);
      if (challenger === null || target === null) {
        return err(
          pvpPlayerIneligible(
            "player-not-found",
            challenger === null ? challenge.challengerPlayerId : challenge.targetPlayerId,
          ),
        );
      }
      if (challenger.areaId !== challenge.areaId || target.areaId !== challenge.areaId) {
        return err(pvpActionInvalid("pvp-same-area-required"));
      }
      if (
        challenger.activeEncounter ||
        target.activeEncounter ||
        challenger.activeBattle ||
        target.activeBattle
      ) {
        return err(pvpFlowBlocked("active-mechanical-flow"));
      }
      if (
        !(await transaction.pinnedContentAvailable(challenge.contentReleaseId, challenge.rulesetId))
      ) {
        return err(pvpFlowBlocked("pinned-content-unavailable"));
      }

      const encounterId = randomUUID();
      const accepted = acceptPvpChallenge(challenge, {
        actorPlayerId: input.actorPlayerId,
        encounterId,
        acceptedAt: now,
      });
      if (!accepted.ok) return err(mapPvpChallengeError(accepted.error));

      if (
        !(await transaction.replaceChallenge({
          expectedRevision: challenge.revision,
          next: accepted.value,
        }))
      ) {
        return err(appError("REVISION_CONFLICT", "PVP challenge acceptance lost a revision race"));
      }

      const seed = this.seedProvider.create(`pvp:challenge:${challenge.id}:encounter`);
      await transaction.insertAcceptedEncounter({
        challenge: accepted.value,
        seed: seed.envelope,
      });

      return ok({
        challenge: accepted.value,
        encounterId,
        replayed: false,
      });
    });
  }

  public async startEncounter(
    input: StartPvpEncounterRequest,
  ): Promise<Result<StartPvpEncounterOutput>> {
    const feature = this.featureError();
    if (feature !== null) return err(feature);
    if (
      !uuid.safeParse(input.challengeId).success ||
      !uuid.safeParse(input.actorPlayerId).success
    ) {
      return err(appError("INVALID_ID", "PVP challenge and actor ids must be valid UUIDs"));
    }
    if (this.startRepository === undefined || this.config.turnWindowTtlMs === undefined) {
      return err(
        appError("FEATURE_UNAVAILABLE", "PVP START is unavailable", {
          reason: "pvp-start-not-configured",
        }),
      );
    }

    const startedAt = this.clock.now();
    const deadlineAt = new Date(startedAt.getTime() + this.config.turnWindowTtlMs);
    if (!Number.isFinite(deadlineAt.getTime())) {
      return err(appError("VALIDATION_FAILED", "PVP TurnWindow deadline is outside Date range"));
    }
    return this.startRepository.start({
      challengeId: input.challengeId,
      actorPlayerId: input.actorPlayerId,
      startedAt,
      deadlineAt,
    });
  }

  public async recoverEncounter(
    input: RecoverPvpEncounterRequest,
  ): Promise<Result<RecoverPvpEncounterOutput>> {
    const feature = this.featureError();
    if (feature !== null) return err(feature);
    if (!uuid.safeParse(input.playerId).success) {
      return err(appError("INVALID_ID", "PVP player id must be a valid UUID"));
    }
    if (this.recoveryRepository === undefined || this.turnResolver === undefined) {
      return err(
        appError("FEATURE_UNAVAILABLE", "PVP recovery is unavailable", {
          reason: "pvp-recovery-not-configured",
        }),
      );
    }

    const current = await this.recoveryRepository.activeForPlayer(input.playerId);
    if (current === null) {
      return err(
        appError("NOT_FOUND", "Active PVP battle was not found", { playerId: input.playerId }),
      );
    }
    if (
      current.state.battleId !== current.battleId ||
      current.state.status !== "ACTIVE" ||
      current.turnWindow.window.battleId !== current.battleId ||
      current.turnWindow.window.battleVersion !== current.state.version
    ) {
      return err(pvpFlowBlocked("recovery-current-state-inconsistent"));
    }

    if (current.turnWindow.window.status === "COLLECTING") {
      return ok({
        battleId: current.battleId,
        state: current.state,
        turnWindow: current.turnWindow.window,
        resolvedLocked: false,
      });
    }
    if (current.turnWindow.window.status !== "LOCKED") {
      return err(pvpFlowBlocked("recovery-window-not-actionable"));
    }

    const resolved = await this.turnResolver.resolve(current.turnWindow.window.id);
    if (!resolved.ok) {
      return err(
        pvpFlowBlocked(`recovery-locked-resolution-failed:${resolved.error.code.toLowerCase()}`),
      );
    }
    if (resolved.value.state.status !== "ACTIVE") {
      return ok({
        battleId: current.battleId,
        state: resolved.value.state,
        turnWindow: null,
        resolvedLocked: true,
      });
    }

    const reloaded = await this.recoveryRepository.activeForPlayer(input.playerId);
    if (reloaded === null) {
      return err(pvpFlowBlocked("recovery-current-window-missing"));
    }
    if (
      reloaded.battleId !== current.battleId ||
      reloaded.state.battleId !== current.battleId ||
      reloaded.state.status !== "ACTIVE" ||
      reloaded.turnWindow.window.battleId !== current.battleId ||
      reloaded.turnWindow.window.battleVersion !== reloaded.state.version
    ) {
      return err(pvpFlowBlocked("recovery-reloaded-state-inconsistent"));
    }

    return ok({
      battleId: reloaded.battleId,
      state: reloaded.state,
      turnWindow: reloaded.turnWindow.window,
      resolvedLocked: true,
    });
  }

  private featureError(): ReturnType<typeof appError> | null {
    return this.feature.enabled
      ? null
      : appError("FEATURE_UNAVAILABLE", "Feature is unavailable", {
          reason: this.feature.reason,
        });
  }

  private validatePlayers(
    challenger: PvpPlayerContext | null,
    target: PvpPlayerContext | null,
  ): ReturnType<typeof appError> | null {
    if (challenger === null) return pvpPlayerIneligible("player-not-found", "challenger");
    const challengerError = playerEligibilityError(challenger);
    if (challengerError !== null) return challengerError;
    if (target === null) return pvpPlayerIneligible("player-not-found", "target");
    return playerEligibilityError(target);
  }
}
