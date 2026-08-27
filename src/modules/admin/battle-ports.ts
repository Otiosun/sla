import type { AdminOperationRecord } from "./contracts.js";
import type {
  AdminBattleCorrectStateInput,
  AdminBattleForceCancelInput,
} from "./battle-contracts.js";

export interface AdminBattleOperationPort {
  applyBattleForceCancel(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBattleForceCancelInput,
  ): Promise<AdminOperationRecord>;
  applyBattleStateCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBattleCorrectStateInput,
  ): Promise<AdminOperationRecord>;
}
