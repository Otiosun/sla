import type { AdminOperationRecord } from "./contracts.js";

export interface AdminPlayerIdentityChangeOwner {
  changeWhatsAppIdentity(input: {
    readonly operation: AdminOperationRecord;
    readonly actorPrincipalId: string;
    readonly externalId: string;
  }): Promise<AdminOperationRecord>;
}
