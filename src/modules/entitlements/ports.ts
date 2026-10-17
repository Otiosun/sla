import type {
  EntitlementGrantInput,
  EntitlementGrantResult,
  PlayerEntitlementView,
} from "./contracts.js";

export interface EntitlementRepository {
  grant(input: EntitlementGrantInput): Promise<EntitlementGrantResult>;
  listPlayerEntitlements(playerId: string): Promise<readonly PlayerEntitlementView[]>;
}
