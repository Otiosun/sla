import type { Pool } from "pg";
import type {
  PlayerPortalCatalogResolveInput,
  PlayerPortalCatalogResolver,
  PlayerPortalCatalogView,
} from "../../modules/player-portal/read-service.js";

interface RegionRow {
  readonly display_name: string;
}

interface FormRow {
  readonly form_id: string;
  readonly display_name: string;
  readonly national_dex: number;
  readonly type1_name: string;
  readonly type2_name: string | null;
}

export class PostgresPlayerPortalCatalogResolver implements PlayerPortalCatalogResolver {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async resolve(input: PlayerPortalCatalogResolveInput): Promise<PlayerPortalCatalogView> {
    const [originRegionName, forms] = await Promise.all([
      this.resolveRegion(input.contentReleaseId, input.originRegionId),
      this.resolveForms(input.contentReleaseId, input.formIds),
    ]);

    return { originRegionName, forms };
  }

  private async resolveRegion(
    contentReleaseId: string,
    originRegionId: string | null,
  ): Promise<string | null> {
    if (originRegionId === null) return null;

    const result = await this.pool.query<RegionRow>(
      `
        SELECT revision.display_name
        FROM region_revisions revision
        WHERE revision.content_release_id = $1
          AND revision.region_id = $2
          AND revision.active = TRUE
        LIMIT 1
      `,
      [contentReleaseId, originRegionId],
    );

    return result.rows[0]?.display_name ?? null;
  }

  private async resolveForms(
    contentReleaseId: string,
    formIds: readonly string[],
  ): Promise<PlayerPortalCatalogView["forms"]> {
    if (formIds.length === 0) return [];

    const result = await this.pool.query<FormRow>(
      `
        SELECT
          form_revision.form_id,
          form_revision.display_name,
          species.national_dex,
          type1_revision.display_name AS type1_name,
          type2_revision.display_name AS type2_name
        FROM pokemon_form_revisions form_revision
        JOIN pokemon_forms form ON form.id = form_revision.form_id
        JOIN pokemon_species species ON species.id = form.species_id
        JOIN pokemon_type_revisions type1_revision
          ON type1_revision.content_release_id = form_revision.content_release_id
         AND type1_revision.type_id = form_revision.type1_id
         AND type1_revision.active = TRUE
        LEFT JOIN pokemon_type_revisions type2_revision
          ON type2_revision.content_release_id = form_revision.content_release_id
         AND type2_revision.type_id = form_revision.type2_id
         AND type2_revision.active = TRUE
        WHERE form_revision.content_release_id = $1
          AND form_revision.active = TRUE
          AND form_revision.form_id = ANY($2::uuid[])
        ORDER BY array_position($2::uuid[], form_revision.form_id)
      `,
      [contentReleaseId, [...formIds]],
    );

    return result.rows.map((row) => ({
      formId: row.form_id,
      displayName: row.display_name,
      nationalDex: row.national_dex,
      typeNames: row.type2_name === null ? [row.type1_name] : [row.type1_name, row.type2_name],
    }));
  }
}
