import { describe, expect, it, vi } from "vitest";
import { AdminRewardCatalogService } from "../../src/modules/admin/reward-catalog-service.js";

describe("AdminRewardCatalogService", () => {
  it("requires both inventory and economy catalog reads before returning content", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "CATALOG", id: null }));
    const getActiveRewardCatalog = vi.fn(async () => ({
      items: [
        {
          itemId: "11111111-1111-4111-8111-111111111111",
          slug: "great-ball",
          displayName: "Great Ball",
          itemKind: "BALL",
        },
      ],
      currencies: [
        {
          currencyId: "22222222-2222-4222-8222-222222222222",
          slug: "poke-dollar",
          displayName: "Poké Dollar",
          allowsNegative: false,
        },
      ],
    }));

    const service = new AdminRewardCatalogService({ authorizeRead }, { getActiveRewardCatalog });

    await expect(service.get("33333333-3333-4333-8333-333333333333")).resolves.toEqual({
      items: [expect.objectContaining({ slug: "great-ball" })],
      currencies: [expect.objectContaining({ slug: "poke-dollar" })],
      species: [],
      forms: [],
      abilities: [],
      natures: [],
      effects: [],
      releases: [],
    });

    expect(authorizeRead).toHaveBeenNthCalledWith(1, {
      principalId: "33333333-3333-4333-8333-333333333333",
      operationType: "inventory.catalog.read",
      input: {},
    });
    expect(authorizeRead).toHaveBeenNthCalledWith(2, {
      principalId: "33333333-3333-4333-8333-333333333333",
      operationType: "economy.currency_catalog.read",
      input: {},
    });
    expect(authorizeRead).toHaveBeenNthCalledWith(3, {
      principalId: "33333333-3333-4333-8333-333333333333",
      operationType: "pokedex.catalog.read",
      input: {},
    });
    expect(getActiveRewardCatalog).toHaveBeenCalledOnce();
  });

  it("does not query the catalog if a requested section authorization is denied", async () => {
    const authorizeRead = vi
      .fn()
      .mockResolvedValueOnce({ type: "ITEM_CATALOG", id: null })
      .mockRejectedValueOnce(new Error("denied"));
    const getActiveRewardCatalog = vi.fn();

    const service = new AdminRewardCatalogService({ authorizeRead }, { getActiveRewardCatalog });

    await expect(service.get("33333333-3333-4333-8333-333333333333")).rejects.toThrow("denied");
    expect(getActiveRewardCatalog).not.toHaveBeenCalled();
  });
});
