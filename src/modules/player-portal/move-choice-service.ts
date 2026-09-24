import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  OperationalPendingMoveChoiceView,
  OperationalUxReadModel,
} from "../messaging/operational-ux-read-model.js";
import { type ExternalIdentity, ExternalIdentitySchema } from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { MoveChoiceResult } from "../progression/contracts.js";
import type { ProgressionService } from "../progression/service.js";

const ResolvePortalMoveChoiceInputSchema = z
  .object({
    choiceId: z.string().uuid(),
    replaceSlotNo: z.number().int().min(1).max(4).nullable(),
  })
  .strict();

export type ResolvePortalMoveChoiceInput = z.infer<typeof ResolvePortalMoveChoiceInputSchema>;

export interface PlayerPortalPendingMoveChoicesView {
  readonly blockedByBattle: boolean;
  readonly choices: readonly OperationalPendingMoveChoiceView[];
}

interface PlayerPortalMoveChoiceDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly profiles: Pick<PlayerStarterService, "getProfile">;
  readonly reads: Pick<OperationalUxReadModel, "listPendingMoveChoices" | "activeBattleId">;
  readonly progression: Pick<ProgressionService, "resolveMoveChoice">;
}

function progressionFailure(error: {
  readonly code: string;
  readonly message: string;
}): ReturnType<typeof appError> {
  if (error.code === "MOVE_CHOICE_NOT_FOUND") {
    return appError("NOT_FOUND", error.message, { progressionCode: error.code });
  }
  if (error.code === "PROGRESSION_INPUT_INVALID") {
    return appError("VALIDATION_FAILED", error.message, { progressionCode: error.code });
  }
  return appError("ACTION_INVALID", error.message, { progressionCode: error.code });
}

export class PlayerPortalMoveChoiceService {
  public constructor(private readonly dependencies: PlayerPortalMoveChoiceDependencies) {}

  public async list(
    identity: ExternalIdentity,
  ): Promise<Result<PlayerPortalPendingMoveChoicesView>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    const [choices, activeBattleId] = await Promise.all([
      this.dependencies.reads.listPendingMoveChoices(eligible.value.playerId),
      this.dependencies.reads.activeBattleId(eligible.value.playerId),
    ]);
    return ok({
      blockedByBattle: activeBattleId !== null,
      choices,
    });
  }

  public async resolve(
    identity: ExternalIdentity,
    input: unknown,
  ): Promise<Result<MoveChoiceResult>> {
    const parsedInput = ResolvePortalMoveChoiceInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return err(appError("VALIDATION_FAILED", "Invalid move choice request"));
    }

    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;
    const playerId = eligible.value.playerId;

    if ((await this.dependencies.reads.activeBattleId(playerId)) !== null) {
      return err(
        appError("FLOW_BLOCKED", "Movimentos não podem ser alterados durante uma batalha ativa."),
      );
    }

    const choices = await this.dependencies.reads.listPendingMoveChoices(playerId);
    const choice = choices.find((candidate) => candidate.choiceId === parsedInput.data.choiceId);
    if (choice === undefined) {
      return err(appError("NOT_FOUND", "Pending move choice was not found"));
    }

    if (
      parsedInput.data.replaceSlotNo !== null &&
      !choice.currentMoves.some((move) => move.slotNo === parsedInput.data.replaceSlotNo)
    ) {
      return err(appError("VALIDATION_FAILED", "Replacement slot is not occupied"));
    }

    const resolved = await this.dependencies.progression.resolveMoveChoice({
      choiceId: choice.choiceId,
      playerId,
      replaceSlotNo: parsedInput.data.replaceSlotNo,
      correlationId: randomUUID(),
    });
    if (!resolved.ok) return err(progressionFailure(resolved.error));
    return ok(resolved.value);
  }

  private async resolveEligible(identity: ExternalIdentity) {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid player identity"));
    }

    const resolved = await this.dependencies.players.resolvePlayer(parsedIdentity.data);
    if (!resolved.ok) return resolved;

    const profile = await this.dependencies.profiles.getProfile(resolved.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
    }

    return ok({ playerId: resolved.value.playerId });
  }
}
