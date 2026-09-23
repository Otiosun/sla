import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftReplaceInput,
} from "../catalog/draft-contracts.js";
import type { AdminOperationRecord } from "./contracts.js";

export interface AdminCatalogDraftOperationPort {
  applyCatalogDraftCreate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftCreateInput,
  ): Promise<AdminOperationRecord>;
  applyCatalogDraftReplace(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftReplaceInput,
  ): Promise<AdminOperationRecord>;
  applyCatalogDraftDeactivate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogDraftDeactivateInput,
  ): Promise<AdminOperationRecord>;
}
