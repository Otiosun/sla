import type {
  AdminBattleCorrectStateInput,
  AdminBattleForceCancelInput,
} from "./battle-contracts.js";
import type { AdminOperationRecord } from "./contracts.js";

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
