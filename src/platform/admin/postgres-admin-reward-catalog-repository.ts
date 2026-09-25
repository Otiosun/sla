import type { Pool } from "pg";
import type { AdminRewardCatalogView } from "../../modules/admin/reward-catalog-contracts.js";
import type { AdminRewardCatalogRepository } from "../../modules/admin/reward-catalog-ports.js";

export class PostgresAdminRewardCatalogRepository implements AdminRewardCatalogRepository {
  public constructor(private readonly pool: Pool) {}

  public async getActiveRewardCatalog(): Promise<AdminRewardCatalogView> {
    const [items, currencies, species] = await Promise.all([
      this.pool.query<{
        item_id: string;
        slug: string;
        display_name: string;
        item_kind: string;
      }>(
        `SELECT item.id AS item_id,
                item.slug,
                revision.display_name,
                revision.item_kind
         FROM content_release_pointers pointer
         JOIN item_revisions revision
           ON revision.content_release_id = pointer.content_release_id
          AND revision.active = TRUE
         JOIN items item ON item.id = revision.item_id
         WHERE pointer.pointer_key = 'ACTIVE'
         ORDER BY lower(revision.display_name), item.slug`,
      ),
      this.pool.query<{
        currency_id: string;
        slug: string;
        display_name: string;
        allows_negative: boolean;
      }>(
        `SELECT id AS currency_id, slug, display_name, allows_negative
         FROM currency_definitions
         ORDER BY lower(display_name), slug`,
      ),
      this.pool.query<{
        species_id: string;
        national_dex: number;
        slug: string;
        display_name: string;
      }>(
        `SELECT species.id AS species_id,
                species.national_dex,
                species.slug,
                revision.display_name
         FROM content_release_pointers pointer
         JOIN pokemon_species_revisions revision
           ON revision.content_release_id = pointer.content_release_id
          AND revision.active = TRUE
         JOIN pokemon_species species ON species.id = revision.species_id
         WHERE pointer.pointer_key = 'ACTIVE'
         ORDER BY species.national_dex, species.slug`,
      ),
    ]);

    return {
      items: items.rows.map((row) => ({
        itemId: row.item_id,
        slug: row.slug,
        displayName: row.display_name,
        itemKind: row.item_kind,
      })),
      currencies: currencies.rows.map((row) => ({
        currencyId: row.currency_id,
        slug: row.slug,
        displayName: row.display_name,
        allowsNegative: row.allows_negative,
      })),
      species: species.rows.map((row) => ({
        speciesId: row.species_id,
        nationalDex: row.national_dex,
        slug: row.slug,
        displayName: row.display_name,
      })),
    };
  }
}
