import type {
  EncounterAdminCloseInput,
  EncounterAdminCloseResult,
  EncounterAdminState,
} from "./admin-contracts.js";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";

export type EncounterAdminClosePersistenceResult =
  | { readonly kind: "APPLIED"; readonly result: EncounterAdminCloseResult }
  | { readonly kind: "REPLAYED"; readonly result: EncounterAdminCloseResult }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "REVISION_CONFLICT"; readonly actualRevision: bigint }
  | { readonly kind: "UNSAFE_FLOW"; readonly reason: string }
  | { readonly kind: "INVALID_STATE"; readonly reason: string }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface EncounterAdminRepository {
  inspect(playerId: PlayerId, encounterId: EncounterId): Promise<EncounterAdminState | null>;
  close(input: EncounterAdminCloseInput): Promise<EncounterAdminClosePersistenceResult>;
}
