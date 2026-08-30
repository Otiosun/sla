import type { CaptureAttemptInput, CaptureAttemptResult } from "../capture/contracts.js";
import { appError, err, type Result } from "../../shared-kernel/result.js";
import {
  DEFAULT_MUTATION_ADMISSION_POLICIES,
  type MutationAdmissionPort,
  type MutationRatePolicy,
} from "./contracts.js";
import { admitProtectedMutation } from "./admission-helper.js";

export interface CaptureMutationOwner {
  attempt(input: CaptureAttemptInput): Promise<Result<CaptureAttemptResult>>;
}

export class ExternalCaptureMutationEndpoint {
  public constructor(
    private readonly owner: CaptureMutationOwner,
    private readonly admission: MutationAdmissionPort,
    private readonly policy: MutationRatePolicy = DEFAULT_MUTATION_ADMISSION_POLICIES.capture,
  ) {}

  public async attempt(input: CaptureAttemptInput): Promise<Result<CaptureAttemptResult>> {
    const admitted = await admitProtectedMutation(this.admission, {
      subjectKind: "PLAYER",
      subjectId: input.playerId,
      surface: "CAPTURE",
      actionKey: "capture.attempt",
      dedupeKey: `${input.playerId}:${input.idempotencyKey.trim()}`,
      fingerprintValue: {
        playerId: input.playerId,
        encounterId: input.encounterId,
        ballItemId: input.ballItemId,
      },
      policy: this.policy,
    });
    if (!admitted.ok) return admitted;
    if (!admitted.value.allowed) {
      return err(
        appError("RATE_LIMITED", "Capture mutation rate limit exceeded", {
          retryAfterMs: admitted.value.retryAfterMs,
        }),
      );
    }
    return this.owner.attempt(input);
  }
}
