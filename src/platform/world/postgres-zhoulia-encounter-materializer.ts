import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  validateZhouliaContentBundle,
  ZHOULIA_TYPED_CONTENT_V1,
  type ZhouliaContentBundle,
} from "../../modules/world/zhoulia-content.js";
import {
  buildBalancedZhouliaEncounterPlans,
  type ZhouliaBalancedEncounterPlan,
} from "../../modules/world/zhoulia-encounter-balance.js";

export interface ZhouliaEncounterMaterializationResult {
  readonly releaseId: string;
  readonly tablesMaterialized: number;
  readonly entriesMaterialized: number;
  readonly balancePolicyVersion: 1;
}

const OPEN_ENTRY_CONDITIONS = Object.freeze({
  schemaVersion: 1 as const,
  requiredUnlockKeys: [] as readonly string[],
  blockedUnlockKeys: [] as readonly string[],
});

function speciesSlug(speciesKey: string): string {
  const prefix = "pokemon.species.";
  if (!speciesKey.startsWith(prefix)) {
    throw new Error(`Unsupported species key: ${speciesKey}`);
  }
  const slug = speciesKey.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid species slug from ${speciesKey}`);
  }
  return slug;
}

async function requireDraftRelease(client: PoolClient, releaseId: string): Promise<void> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM content_releases WHERE id=$1 FOR UPDATE",
    [releaseId],
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new Error(`Content release ${releaseId} does not exist`);
  if (status !== "DRAFT") {
    throw new Error(`Zhoulia encounter materialization requires DRAFT; found ${status}`);
  }
}

async function resolveAreaId(
  client: PoolClient,
  releaseId: string,
  areaIdentity: string,
): Promise<string> {
  const slug = areaIdentity.split(".").at(-1);
  if (slug === undefined) throw new Error(`Invalid area identity ${areaIdentity}`);
  const result = await client.query<{ id: string }>(
    `SELECT area.id
     FROM areas AS area
     JOIN regions AS region ON region.id=area.region_id
     JOIN area_revisions AS revision
       ON revision.area_id=area.id
      AND revision.content_release_id=$1
     WHERE region.slug='zhoulia'
       AND area.slug=$2
       AND revision.active=TRUE
     LIMIT 1`,
    [releaseId, slug],
  );
  const areaId = result.rows[0]?.id;
  if (areaId === undefined) throw new Error(`Area ${areaIdentity} is not imported in the DRAFT`);
  return areaId;
}

async function resolveFormId(
  client: PoolClient,
  releaseId: string,
  speciesKey: string,
): Promise<string> {
  const slug = speciesSlug(speciesKey);
  const result = await client.query<{ id: string; form_slug: string; species_slug: string }>(
    `SELECT form.id, form.slug AS form_slug, species.slug AS species_slug
     FROM pokemon_species AS species
     JOIN pokemon_species_revisions AS species_revision
       ON species_revision.species_id=species.id
      AND species_revision.content_release_id=$1
      AND species_revision.active=TRUE
     JOIN pokemon_forms AS form ON form.species_id=species.id
     JOIN pokemon_form_revisions AS form_revision
       ON form_revision.form_id=form.id
      AND form_revision.content_release_id=$1
      AND form_revision.active=TRUE
     WHERE species.slug=$2
     ORDER BY form.slug, form.id`,
    [releaseId, slug],
  );

  if (result.rows.length === 0) {
    throw new Error(`No active form found for ${speciesKey} in this release`);
  }
  if (result.rows.length === 1) return result.rows[0]?.id ?? "";

  const preferred = result.rows.filter(
    (row) =>
      row.form_slug === "default" ||
      row.form_slug === "normal" ||
      row.form_slug === row.species_slug,
  );
  if (preferred.length === 1) return preferred[0]?.id ?? "";

  throw new Error(
    `Species ${speciesKey} has multiple active forms and no unique canonical default form`,
  );
}

async function ensureTable(
  client: PoolClient,
  releaseId: string,
  areaId: string,
  plan: ZhouliaBalancedEncounterPlan,
): Promise<{ readonly revisionId: string; readonly tableId: string }> {
  const table = await client.query<{ id: string }>(
    "SELECT id FROM encounter_tables WHERE area_id=$1 AND slug=$2",
    [areaId, plan.tableSlug],
  );
  const tableId = table.rows[0]?.id ?? randomUUID();
  if (table.rows[0] === undefined) {
    await client.query("INSERT INTO encounter_tables(id,area_id,slug) VALUES ($1,$2,$3)", [
      tableId,
      areaId,
      plan.tableSlug,
    ]);
  }

  const revision = await client.query<{ id: string }>(
    `SELECT id FROM encounter_table_revisions
     WHERE content_release_id=$1 AND encounter_table_id=$2`,
    [releaseId, tableId],
  );
  const revisionId = revision.rows[0]?.id ?? randomUUID();
  if (revision.rows[0] === undefined) {
    await client.query(
      `INSERT INTO encounter_table_revisions(
         id,content_release_id,encounter_table_id,active,conditions
       ) VALUES ($1,$2,$3,TRUE,$4::jsonb)`,
      [revisionId, releaseId, tableId, JSON.stringify(plan.conditions)],
    );
  } else {
    await client.query(
      `UPDATE encounter_table_revisions
       SET active=TRUE, conditions=$3::jsonb
       WHERE content_release_id=$1 AND encounter_table_id=$2`,
      [releaseId, tableId, JSON.stringify(plan.conditions)],
    );
  }
  return { revisionId, tableId };
}

export class PostgresZhouliaEncounterDraftMaterializer {
  public constructor(private readonly pool: Pool) {}

  public async materialize(input: {
    readonly releaseId: string;
    readonly bundle?: ZhouliaContentBundle;
  }): Promise<ZhouliaEncounterMaterializationResult> {
    const bundle = input.bundle ?? ZHOULIA_TYPED_CONTENT_V1;
    validateZhouliaContentBundle(bundle);
    const plans = buildBalancedZhouliaEncounterPlans(bundle);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `catalog-release:${input.releaseId}`,
      ]);
      await requireDraftRelease(client, input.releaseId);

      let entriesMaterialized = 0;
      for (const plan of plans) {
        const areaId = await resolveAreaId(client, input.releaseId, plan.areaIdentity);
        const table = await ensureTable(client, input.releaseId, areaId, plan);
        await client.query("DELETE FROM encounter_entries WHERE encounter_table_revision_id=$1", [
          table.revisionId,
        ]);

        for (const entry of plan.entries) {
          const formId = await resolveFormId(client, input.releaseId, entry.speciesKey);
          await client.query(
            `INSERT INTO encounter_entries(
               id,encounter_table_revision_id,form_id,weight,min_level,max_level,active,conditions
             ) VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7::jsonb)`,
            [
              randomUUID(),
              table.revisionId,
              formId,
              entry.weight.toString(),
              entry.minLevel,
              entry.maxLevel,
              JSON.stringify(OPEN_ENTRY_CONDITIONS),
            ],
          );
          entriesMaterialized += 1;
        }
      }

      await client.query("COMMIT");
      return {
        releaseId: input.releaseId,
        tablesMaterialized: plans.length,
        entriesMaterialized,
        balancePolicyVersion: 1,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
