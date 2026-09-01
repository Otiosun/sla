import type { Pool } from "pg";
import type {
  ContentLibraryItemView,
  ContentLibrarySearchResultView,
} from "../../modules/admin/content-library-contracts.js";
import type {
  ContentLibraryRepository,
  ContentLibraryRepositorySearch,
} from "../../modules/admin/content-library-ports.js";

interface ContentLibraryRow {
  readonly release_id: string;
  readonly release_no: string;
  readonly release_name: string;
  readonly release_status: ContentLibraryItemView["releaseStatus"];
  readonly release_revision: string;
  readonly resource_kind: ContentLibraryItemView["resourceKind"];
  readonly resource_id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly active: boolean;
}

function encodeCursor(item: ContentLibraryItemView): string {
  return Buffer.from(
    JSON.stringify({
      releaseNo: item.releaseNo,
      resourceKind: item.resourceKind,
      slug: item.slug,
      resourceId: item.resourceId,
    }),
    "utf8",
  ).toString("base64url");
}

function project(row: ContentLibraryRow): ContentLibraryItemView {
  return {
    releaseId: row.release_id,
    releaseNo: row.release_no,
    releaseName: row.release_name,
    releaseStatus: row.release_status,
    releaseRevision: row.release_revision,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    slug: row.slug,
    displayName: row.display_name,
    active: row.active,
  };
}

export class PostgresContentLibraryRepository implements ContentLibraryRepository {
  public constructor(private readonly pool: Pool) {}

  public async searchContent(
    input: ContentLibraryRepositorySearch,
  ): Promise<ContentLibrarySearchResultView> {
    const cursor = input.cursor;
    const result = await this.pool.query<ContentLibraryRow>(
      `WITH content AS (
         SELECT revision.content_release_id, 'SPECIES'::text AS resource_kind,
                identity.id AS resource_id, identity.slug, revision.display_name, revision.active
         FROM pokemon_species identity
         JOIN pokemon_species_revisions revision ON revision.species_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'MOVE'::text, identity.id, identity.slug,
                revision.display_name, revision.active
         FROM moves identity
         JOIN move_revisions revision ON revision.move_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'ITEM'::text, identity.id, identity.slug,
                revision.display_name, revision.active
         FROM items identity
         JOIN item_revisions revision ON revision.item_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'AREA'::text, identity.id, identity.slug,
                revision.display_name, revision.active
         FROM areas identity
         JOIN area_revisions revision ON revision.area_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'ENCOUNTER_TABLE'::text, identity.id, identity.slug,
                identity.slug AS display_name, revision.active
         FROM encounter_tables identity
         JOIN encounter_table_revisions revision ON revision.encounter_table_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'REWARD'::text, identity.id, identity.slug,
                revision.display_name, revision.active
         FROM reward_definitions identity
         JOIN reward_revisions revision ON revision.reward_id = identity.id
         UNION ALL
         SELECT revision.content_release_id, 'EFFECT'::text, identity.id, identity.slug,
                identity.slug AS display_name, revision.active
         FROM effects identity
         JOIN effect_revisions revision ON revision.effect_id = identity.id
       )
       SELECT release.id AS release_id,
              release.release_no::text AS release_no,
              release.name AS release_name,
              release.status AS release_status,
              release.revision::text AS release_revision,
              content.resource_kind,
              content.resource_id,
              content.slug,
              content.display_name,
              content.active
       FROM content
       JOIN content_releases release ON release.id = content.content_release_id
       WHERE ($1::text IS NULL OR content.slug ILIKE '%' || $1 || '%'
              OR content.display_name ILIKE '%' || $1 || '%'
              OR release.name ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR content.resource_kind = $2)
         AND ($3::text IS NULL OR release.status = $3)
         AND ($4::boolean IS NULL OR content.active = $4)
         AND (
           $5::bigint IS NULL
           OR release.release_no < $5
           OR (
             release.release_no = $5
             AND (content.resource_kind, content.slug, content.resource_id)
               > ($6::text, $7::text, $8::uuid)
           )
         )
       ORDER BY release.release_no DESC,
                content.resource_kind ASC,
                content.slug ASC,
                content.resource_id ASC
       LIMIT $9`,
      [
        input.query ?? null,
        input.resourceKind ?? null,
        input.releaseStatus ?? null,
        input.active ?? null,
        cursor?.releaseNo ?? null,
        cursor?.resourceKind ?? null,
        cursor?.slug ?? null,
        cursor?.resourceId ?? null,
        input.limit + 1,
      ],
    );

    const hasMore = result.rows.length > input.limit;
    const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    const items = rows.map(project);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }
}
