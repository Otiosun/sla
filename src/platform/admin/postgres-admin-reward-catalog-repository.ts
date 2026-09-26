import type { Pool } from "pg";
import type { AdminRewardCatalogView } from "../../modules/admin/reward-catalog-contracts.js";
import type { AdminRewardCatalogRepository } from "../../modules/admin/reward-catalog-ports.js";

export class PostgresAdminRewardCatalogRepository implements AdminRewardCatalogRepository {
  public constructor(private readonly pool: Pool) {}

  public async getActiveRewardCatalog(): Promise<AdminRewardCatalogView> {
    const [items, currencies, species, forms, effects, releases] = await Promise.all([
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
      this.pool.query<{
        form_id: string;
        species_id: string;
        national_dex: number;
        species_slug: string;
        form_slug: string;
        display_name: string;
      }>(
        `SELECT form.id AS form_id,
                species.id AS species_id,
                species.national_dex,
                species.slug AS species_slug,
                form.slug AS form_slug,
                COALESCE(form_revision.display_name, species_revision.display_name) AS display_name
         FROM content_release_pointers pointer
         JOIN pokemon_forms form ON TRUE
         JOIN pokemon_species species ON species.id = form.species_id
         JOIN pokemon_species_revisions species_revision
           ON species_revision.content_release_id = pointer.content_release_id
          AND species_revision.species_id = species.id
          AND species_revision.active = TRUE
         LEFT JOIN pokemon_form_revisions form_revision
           ON form_revision.content_release_id = pointer.content_release_id
          AND form_revision.form_id = form.id
          AND form_revision.active = TRUE
         WHERE pointer.pointer_key = 'ACTIVE'
           AND (form_revision.id IS NOT NULL OR form.slug = 'default')
         ORDER BY species.national_dex, form.slug`,
      ),
      this.pool.query<{
        effect_id: string;
        slug: string;
        scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA";
      }>(
        `SELECT effect.id AS effect_id,
                effect.slug,
                revision.scope
         FROM content_release_pointers pointer
         JOIN effect_revisions revision
           ON revision.content_release_id = pointer.content_release_id
          AND revision.active = TRUE
         JOIN effects effect ON effect.id = revision.effect_id
         WHERE pointer.pointer_key = 'ACTIVE'
         ORDER BY effect.slug`,
      ),
      this.pool.query<{
        release_id: string;
        release_no: string;
        name: string;
        status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
        revision: string;
        parent_release_id: string | null;
        default_ruleset_id: string;
        active: boolean;
        created_at: Date;
        published_at: Date | null;
      }>(
        `SELECT release.id AS release_id,
                release.release_no::text,
                release.name,
                release.status,
                release.revision::text,
                release.parent_release_id,
                release.default_ruleset_id,
                EXISTS (
                  SELECT 1
                  FROM content_release_pointers pointer
                  WHERE pointer.pointer_key = 'ACTIVE'
                    AND pointer.content_release_id = release.id
                ) AS active,
                release.created_at,
                release.published_at
         FROM content_releases release
         ORDER BY release.release_no DESC, release.id`,
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
      forms: forms.rows.map((row) => ({
        formId: row.form_id,
        speciesId: row.species_id,
        nationalDex: row.national_dex,
        speciesSlug: row.species_slug,
        formSlug: row.form_slug,
        displayName: row.display_name,
      })),
      effects: effects.rows.map((row) => ({
        effectId: row.effect_id,
        slug: row.slug,
        scope: row.scope,
      })),
      releases: releases.rows.map((row) => ({
        releaseId: row.release_id,
        releaseNo: row.release_no,
        name: row.name,
        status: row.status,
        revision: row.revision,
        parentReleaseId: row.parent_release_id,
        defaultRulesetId: row.default_ruleset_id,
        active: row.active,
        createdAt: row.created_at.toISOString(),
        publishedAt: row.published_at?.toISOString() ?? null,
      })),
    };
  }
}
