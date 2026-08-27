import type { ReleaseDiff } from "../catalog/diff.js";
import type {
  CatalogReleaseDiffInput,
  CatalogReleaseLifecycleInput,
} from "../catalog/release-admin-contracts.js";
import type { AdminOperationRecord, AdminSimulationResult } from "./contracts.js";

export interface AdminCatalogReleaseOperationPort {
  diff(input: CatalogReleaseDiffInput & { readonly principalId: string }): Promise<ReleaseDiff>;
  simulateCatalogReleasePublish(input: CatalogReleaseLifecycleInput): Promise<AdminSimulationResult>;
  applyCatalogReleaseValidate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogReleaseLifecycleInput,
  ): Promise<AdminOperationRecord>;
  applyCatalogReleasePublish(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: CatalogReleaseLifecycleInput,
  ): Promise<AdminOperationRecord>;
}
