import type { AdminService } from "./service.js";
import type { AdminRewardCatalogRepository } from "./reward-catalog-ports.js";
import type { AdminRewardCatalogView } from "./reward-catalog-contracts.js";

export class AdminRewardCatalogService {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly repository: AdminRewardCatalogRepository,
  ) {}

  public async get(principalId: string): Promise<AdminRewardCatalogView> {
    await this.authorizer.authorizeRead({
      principalId,
      operationType: "inventory.catalog.read",
      input: {},
    });
    await this.authorizer.authorizeRead({
      principalId,
      operationType: "economy.currency_catalog.read",
      input: {},
    });
    return this.repository.getActiveRewardCatalog();
  }
}
