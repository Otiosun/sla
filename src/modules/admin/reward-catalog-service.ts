import type { AdminService } from "./service.js";
import type { AdminRewardCatalogView } from "./reward-catalog-contracts.js";
import type { AdminRewardCatalogRepository } from "./reward-catalog-ports.js";

export interface AdminRewardCatalogSections {
  readonly items: boolean;
  readonly currencies: boolean;
  readonly species: boolean;
  readonly forms?: boolean;
  readonly effects?: boolean;
  readonly releases?: boolean;
}

const ALL_REWARD_CATALOG_SECTIONS: AdminRewardCatalogSections = {
  items: true,
  currencies: true,
  species: true,
  forms: true,
  effects: true,
  releases: true,
};

export class AdminRewardCatalogService {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly repository: AdminRewardCatalogRepository,
  ) {}

  public async get(
    principalId: string,
    sections: AdminRewardCatalogSections = ALL_REWARD_CATALOG_SECTIONS,
  ): Promise<AdminRewardCatalogView> {
    if (sections.items) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "inventory.catalog.read",
        input: {},
      });
    }
    if (sections.currencies) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "economy.currency_catalog.read",
        input: {},
      });
    }
    if (sections.species) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "pokedex.catalog.read",
        input: {},
      });
    }
    if (sections.forms) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "pokemon.form_catalog.read",
        input: {},
      });
    }
    if (sections.effects) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "pokemon.effect_catalog.read",
        input: {},
      });
    }
    if (sections.releases) {
      await this.authorizer.authorizeRead({
        principalId,
        operationType: "content.release.catalog.read",
        input: {},
      });
    }

    const catalog = await this.repository.getActiveRewardCatalog();
    return {
      items: sections.items ? catalog.items : [],
      currencies: sections.currencies ? catalog.currencies : [],
      species: sections.species ? (catalog.species ?? []) : [],
      forms: sections.forms ? (catalog.forms ?? []) : [],
      effects: sections.effects ? (catalog.effects ?? []) : [],
      releases: sections.releases ? (catalog.releases ?? []) : [],
    };
  }
}
