import type { AdminOperationRecord } from "./contracts.js";
import type {
  AdminInventoryAdjustInput,
  AdminWalletAdjustInput,
} from "./domain-contracts.js";

export interface AdminDomainOperationPort {
  applyInventoryAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminInventoryAdjustInput,
  ): Promise<AdminOperationRecord>;
  applyWalletAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminWalletAdjustInput,
  ): Promise<AdminOperationRecord>;
}
