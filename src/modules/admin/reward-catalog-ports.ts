import type { AdminRewardCatalogView } from "./reward-catalog-contracts.js";

export interface AdminRewardCatalogRepository {
  getActiveRewardCatalog(): Promise<AdminRewardCatalogView>;
}
