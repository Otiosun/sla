import type {
  AcceptPvpChallengeOutput,
  AcceptPvpChallengeRequest,
  CreatePvpChallengeOutput,
  CreatePvpChallengeRequest,
  StartPvpEncounterOutput,
  StartPvpEncounterRequest,
} from "../pvp/service.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { admitProtectedMutation } from "./admission-helper.js";
import {
  DEFAULT_MUTATION_ADMISSION_POLICIES,
  type MutationAdmissionPort,
  type MutationRatePolicy,
} from "./contracts.js";

export interface PvpMutationOwner {
  createChallenge(input: CreatePvpChallengeRequest): Promise<Result<CreatePvpChallengeOutput>>;
  acceptChallenge(input: AcceptPvpChallengeRequest): Promise<Result<AcceptPvpChallengeOutput>>;
  startEncounter(input: StartPvpEncounterRequest): Promise<Result<StartPvpEncounterOutput>>;
}

export class ExternalPvpMutationEndpoint {
  public constructor(
    private readonly owner: PvpMutationOwner,
    private readonly admission: MutationAdmissionPort,
    private readonly policy: MutationRatePolicy = DEFAULT_MUTATION_ADMISSION_POLICIES.battle,
  ) {}

  public async createChallenge(
    input: CreatePvpChallengeRequest,
  ): Promise<Result<CreatePvpChallengeOutput>> {
    const admitted = await this.admit({
      subjectId: input.challengerPlayerId,
      actionKey: "pvp.create-challenge",
      dedupeKey: `pvp:create:${input.challengerPlayerId}:${input.idempotencyKey.trim()}`,
      fingerprintValue: {
        targetPlayerId: input.targetPlayerId,
        formatKey: input.formatKey,
        reachPolicy: input.reachPolicy,
      },
    });
    if (!admitted.ok) return err(admitted.error);
    return this.owner.createChallenge(input);
  }

  public async acceptChallenge(
    input: AcceptPvpChallengeRequest,
  ): Promise<Result<AcceptPvpChallengeOutput>> {
    const admitted = await this.admit({
      subjectId: input.actorPlayerId,
      actionKey: "pvp.accept-challenge",
      dedupeKey: `pvp:accept:${input.actorPlayerId}:${input.challengeId}`,
      fingerprintValue: { challengeId: input.challengeId },
    });
    if (!admitted.ok) return err(admitted.error);
    return this.owner.acceptChallenge(input);
  }

  public async startEncounter(
    input: StartPvpEncounterRequest,
  ): Promise<Result<StartPvpEncounterOutput>> {
    const admitted = await this.admit({
      subjectId: input.actorPlayerId,
      actionKey: "pvp.start-encounter",
      dedupeKey: `pvp:start:${input.actorPlayerId}:${input.challengeId}`,
      fingerprintValue: { challengeId: input.challengeId },
    });
    if (!admitted.ok) return err(admitted.error);
    return this.owner.startEncounter(input);
  }

  private async admit(input: {
    readonly subjectId: string;
    readonly actionKey: string;
    readonly dedupeKey: string;
    readonly fingerprintValue: unknown;
  }): Promise<Result<void>> {
    const admitted = await admitProtectedMutation(this.admission, {
      subjectKind: "PLAYER",
      subjectId: input.subjectId,
      surface: "BATTLE",
      actionKey: input.actionKey,
      dedupeKey: input.dedupeKey,
      fingerprintValue: input.fingerprintValue,
      policy: this.policy,
    });
    if (!admitted.ok) return err(admitted.error);
    if (!admitted.value.allowed) {
      return err(
        appError("RATE_LIMITED", "PVP mutation rate limit exceeded", {
          surface: "BATTLE",
          actionKey: input.actionKey,
          retryAfterMs: admitted.value.retryAfterMs,
        }),
      );
    }
    return ok(undefined);
  }
}
