import type { PurchaseResult } from "../economy/contracts.js";
import type { PurchaseInput } from "../economy/service.js";
import { appError, err, type Result } from "../../shared-kernel/result.js";
import {
  DEFAULT_MUTATION_ADMISSION_POLICIES,
  type MutationAdmissionPort,
  type MutationRatePolicy,
} from "./contracts.js";
import { admitProtectedMutation } from "./admission-helper.js";

export interface EconomyPurchaseOwner {
  purchase(input: PurchaseInput): Promise<Result<PurchaseResult>>;
}

export class ExternalEconomyMutationEndpoint {
  public constructor(
    private readonly owner: EconomyPurchaseOwner,
    private readonly admission: MutationAdmissionPort,
    private readonly policy: MutationRatePolicy = DEFAULT_MUTATION_ADMISSION_POLICIES.economy,
  ) {}

  public async purchase(input: PurchaseInput): Promise<Result<PurchaseResult>> {
    if (input.metadata.actorType !== "PLAYER" || input.metadata.actorId !== input.playerId) {
      return err(
        appError(
          "PLAYER_INELIGIBLE",
          "External economy mutations must be purchases owned by the same player",
        ),
      );
    }

    const admitted = await admitProtectedMutation(this.admission, {
      subjectKind: "PLAYER",
      subjectId: input.playerId,
      surface: "ECONOMY",
      actionKey: "economy.purchase",
      dedupeKey: `${input.playerId}:${input.idempotencyKey.trim()}`,
      fingerprintValue: {
        playerId: input.playerId,
        offerKey: input.offerKey,
        sourceType: input.metadata.sourceType,
        sourceId: input.metadata.sourceId,
        reason: input.metadata.reason,
        actorType: input.metadata.actorType,
        actorId: input.metadata.actorId,
      },
      policy: this.policy,
    });
    if (!admitted.ok) return admitted;
    if (!admitted.value.allowed) {
      return err(
        appError("RATE_LIMITED", "Economy mutation rate limit exceeded", {
          retryAfterMs: admitted.value.retryAfterMs,
        }),
      );
    }
    return this.owner.purchase(input);
  }
}
