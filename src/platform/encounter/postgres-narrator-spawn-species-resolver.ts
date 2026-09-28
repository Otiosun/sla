import type { Pool } from "pg";

export interface NarratorSpawnSpeciesMatch {
  readonly formId: string;
  readonly displayName: string;
}

function normalizedSlug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export class PostgresNarratorSpawnSpeciesResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolve(reference: string): Promise<NarratorSpawnSpeciesMatch | null> {
    const display = reference.trim();
    if (display.length === 0) return null;
    const slug = normalizedSlug(display);
    const result = await this.pool.query<{
      form_id: string;
      display_name: string;
    }>(
      `SELECT form.id::text AS form_id,
              species_revision.display_name
       FROM content_release_pointers pointer
       JOIN pokemon_species_revisions species_revision
         ON species_revision.content_release_id = pointer.content_release_id
        AND species_revision.active = TRUE
       JOIN pokemon_species species
         ON species.id = species_revision.species_id
       JOIN pokemon_forms form
         ON form.species_id = species.id
       JOIN pokemon_form_revisions form_revision
         ON form_revision.content_release_id = pointer.content_release_id
        AND form_revision.form_id = form.id
        AND form_revision.active = TRUE
       WHERE pointer.pointer_key = 'ACTIVE'
         AND (
           lower(species.slug) = lower($1)
           OR lower(species_revision.display_name) = lower($2)
         )
       ORDER BY CASE WHEN form.slug = 'default' THEN 0 ELSE 1 END, form.slug
       LIMIT 1`,
      [slug, display],
    );
    const row = result.rows[0];
    return row === undefined ? null : { formId: row.form_id, displayName: row.display_name };
  }
}
