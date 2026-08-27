import type { AdminOperationRecord } from "./contracts.js";
import type { AdminEncounterCloseInput } from "./domain-contracts.js";

export interface AdminEncounterOperationPort {
  applyEncounterClose(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminEncounterCloseInput,
  ): Promise<AdminOperationRecord>;
}
