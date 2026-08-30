import type { BattleServiceResult, ResolvePlayerTurnInput, ResolvePlayerTurnOutput } from "../battle/service.js";
import { DEFAULT_MUTATION_ADMISSION_POLICIES, type MutationAdmissionPort } from "./contracts.js";
import { admitProtectedMutation } from "./admission-helper.js";

export interface BattleActionOwner {
  resolvePlayerTurn(input: ResolvePlayerTurnInput): Promise<BattleServiceResult<ResolvePlayerTurnOutput>>;
}

export class ProtectedBattleGateway {
  public constructor(
    private readonly owner: BattleActionOwner,
    private readonly admission: MutationAdmissionPort,
  ) {}

  public async resolvePlayerTurn(input: ResolvePlayerTurnInput) {
    const admitted = await admitProtectedMutation(this.admission, {
      subjectKind: "PLAYER",
      subjectId: input.playerId,
      surface: "BATTLE",
      actionKey: "battle.resolve-player-turn",
      dedupeKey: `${input.playerId}:${input.idempotencyKey.trim()}`,
      fingerprintValue: { battleId: input.battleId, expectedVersion: input.expectedVersion, action: input.action },
      policy: DEFAULT_MUTATION_ADMISSION_POLICIES.battle,
    });
    if (!admitted.ok) {
      return {
        ok: false as const,
        error: {
          code: admitted.error.code === "FINGERPRINT_MISMATCH" ? "BATTLE_IDEMPOTENCY_CONFLICT" as const : "BATTLE_ACTION_INVALID" as const,
          message: admitted.error.message,
        },
      };
    }
    if (!admitted.value.allowed) {
      return {
        ok: false as const,
        error: {
          code: "BATTLE_RATE_LIMITED" as const,
          message: "Battle action rate limit exceeded",
          details: { retryAfterMs: admitted.value.retryAfterMs },
        },
      };
    }
    return this.owner.resolvePlayerTurn(input);
  }
}
