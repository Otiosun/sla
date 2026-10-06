import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresAdminRewardCatalogRepository } from "../../src/platform/admin/postgres-admin-reward-catalog-repository.js";

describe("PostgresAdminRewardCatalogRepository", () => {
  it("only exposes Pokemon forms with an active revision in the active release", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);

      if (sql.includes("SELECT form.id AS form_id")) {
        return {
          rows: [
            {
              form_id: "11111111-1111-4111-8111-111111111111",
              species_id: "22222222-2222-4222-8222-222222222222",
              national_dex: 8,
              species_slug: "wartortle",
              form_slug: "wartortle",
              display_name: "Wartortle",
            },
          ],
        };
      }

      return { rows: [] };
    });

    const repository = new PostgresAdminRewardCatalogRepository({ query } as unknown as Pool);
    const catalog = await repository.getActiveRewardCatalog();

    expect(catalog.forms).toEqual([
      expect.objectContaining({
        speciesSlug: "wartortle",
        displayName: "Wartortle",
      }),
    ]);

    const formQuery = queries.find((sql) => sql.includes("SELECT form.id AS form_id"));
    expect(formQuery).toBeDefined();
    expect(formQuery).toContain("JOIN pokemon_form_revisions form_revision");
    expect(formQuery).toContain("form_revision.active = TRUE");
    expect(formQuery).not.toContain("LEFT JOIN pokemon_form_revisions");
    expect(formQuery).not.toContain("form.slug = 'default'");
  });
});
