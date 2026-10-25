import type { Pool, PoolClient } from "pg";
import {
  encounterConditionsAllow,
  parseEncounterConditions,
  type EncounterEnvironmentContext,
} from "../../modules/catalog/encounter-contracts.js";
import type { PinnedEligibleExpeditionEncounterPool } from "../../modules/exploration/expedition-encounter-weighting.js";
import { withTransaction } from "../db/transaction.js";

interface TableRow {
  readonly revision_id: string;
  readonly conditions: unknown;
}
interface EligibleEntryRow {
  readonly entry_id: string;
  readonly species_id: string;
  readonly form_id: string;
  readonly weight: string;
  readonly conditions: unknown;
}
interface SpeciesRow {
  readonly species_id: string;
}

export interface ReadEligibleExpeditionPoolInput {
  readonly playerId: string;
  readonly contentReleaseId: string;
  readonly areaId: string;
  /** An explicit canonical table, never a silent choice among multiple tables. */
  readonly encounterTableSlug: string;
  /** Derived from the server-side expedition phase and real World context. */
  readonly environment: EncounterEnvironmentContext & {
    readonly timeOfDay: "DAY" | "NIGHT";
    readonly surface: "LAND" | "WATER";
  };
}
export interface EligibleExpeditionPoolRead {
  readonly pool: PinnedEligibleExpeditionEncounterPool;
  /** Only seen or caught species in the eligible filtered pool, never all Pokédex entries. */
  readonly knownSpeciesIds: readonly string[];
}

const TABLE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Safe read-only V1.2 adapter. All data is pinned to a published ACTIVE release,
 * an open Zhoulia launch area, and the *same* player's World location.
 * Empty/ineligible conditions return null; invalid published rows fail closed.
 *
 * This read is NOT a gameplay admission. Before any RNG/clock/Encounter write,
 * the orchestrator must repeat the query under its shared World player lock.
 */
export async function eligibleExpeditionPoolInTransaction(
  client: PoolClient,
  input: ReadEligibleExpeditionPoolInput,
  lockActivePointer = false,
): Promise<EligibleExpeditionPoolRead | null> {
  if (
    !TABLE_SLUG_PATTERN.test(input.encounterTableSlug) ||
    input.environment.timeOfDay === undefined ||
    input.environment.surface === undefined
  ) {
    return null;
  }

  const tables = await client.query<TableRow>(
    `SELECT table_revision.id::text AS revision_id, table_revision.conditions
       FROM content_release_pointers pointer
       JOIN content_releases release
         ON release.id = pointer.content_release_id
        AND release.status = 'PUBLISHED'
       JOIN rulesets ruleset
         ON ruleset.id = release.default_ruleset_id
        AND ruleset.status = 'PUBLISHED'
       JOIN areas area ON area.id = $3::uuid
       JOIN regions region ON region.id = area.region_id
       JOIN region_revisions region_revision
         ON region_revision.region_id = region.id
        AND region_revision.content_release_id = release.id
        AND region_revision.active = TRUE
       JOIN area_revisions area_revision
         ON area_revision.area_id = area.id
        AND area_revision.content_release_id = release.id
        AND area_revision.active = TRUE
       JOIN player_locations location
         ON location.player_id = $1::uuid
        AND location.area_id = area.id
       JOIN players player
         ON player.id = location.player_id
        AND player.status = 'ACTIVE'
       JOIN onboarding_states onboarding
         ON onboarding.player_id = player.id
        AND onboarding.state = 'COMPLETE'
       JOIN encounter_tables table_identity
         ON table_identity.area_id = area.id
        AND table_identity.slug = $4
       JOIN encounter_table_revisions table_revision
         ON table_revision.encounter_table_id = table_identity.id
        AND table_revision.content_release_id = release.id
        AND table_revision.active = TRUE
      WHERE pointer.pointer_key = 'ACTIVE'
        AND release.id = $2::uuid
        AND region.slug = 'zhoulia'
        AND area.slug IN ('vila-dos-arrozais', 'campos-de-yun')
      ${lockActivePointer ? "FOR SHARE OF pointer" : ""}`,
    [input.playerId, input.contentReleaseId, input.areaId, input.encounterTableSlug],
  );
  const table = tables.rows[0];
  if (table === undefined || tables.rows.length !== 1) return null;
  const tableConditions = parseEncounterConditions(table.conditions);
  if (!tableConditions.success) {
    throw new Error("Published expedition table has invalid encounter conditions");
  }

  const unlocks = await client.query<{ unlock_key: string }>(
    "SELECT unlock_key FROM trainer_unlocks WHERE player_id=$1::uuid AND status='ACTIVE'",
    [input.playerId],
  );
  const unlockedKeys = new Set(unlocks.rows.map((row) => row.unlock_key));
  if (!encounterConditionsAllow(tableConditions.data, unlockedKeys, input.environment)) {
    return null;
  }

  const rows = await client.query<EligibleEntryRow>(
    `SELECT entry.id::text AS entry_id,
            form.species_id::text AS species_id,
            entry.form_id::text AS form_id,
            entry.weight::text AS weight,
            entry.conditions
       FROM encounter_entries entry
       JOIN pokemon_forms form ON form.id = entry.form_id
       JOIN pokemon_form_revisions form_revision
         ON form_revision.form_id = form.id
        AND form_revision.content_release_id = $2::uuid
        AND form_revision.active = TRUE
       JOIN pokemon_species_revisions species_revision
         ON species_revision.species_id = form.species_id
        AND species_revision.content_release_id = $2::uuid
        AND species_revision.active = TRUE
      WHERE entry.encounter_table_revision_id = $1::uuid
        AND entry.active = TRUE
      ORDER BY entry.id`,
    [table.revision_id, input.contentReleaseId],
  );
  const entries: {
    entryId: string;
    speciesId: string;
    formId: string;
    weight: number;
  }[] = [];
  for (const row of rows.rows) {
    const conditions = parseEncounterConditions(row.conditions);
    const weight = Number(row.weight);
    if (!conditions.success || !Number.isSafeInteger(weight) || weight <= 0) {
      throw new Error("Published expedition entry has invalid conditions or weight");
    }
    if (!encounterConditionsAllow(conditions.data, unlockedKeys, input.environment)) continue;
    entries.push({
      entryId: row.entry_id,
      speciesId: row.species_id,
      formId: row.form_id,
      weight,
    });
  }
  if (entries.length === 0) return null;

  const speciesIds = [...new Set(entries.map((entry) => entry.speciesId))];
  const known = await client.query<SpeciesRow>(
    `SELECT species_id::text
       FROM player_pokedex_species
      WHERE player_id = $1::uuid
        AND (seen_count > 0 OR caught_count > 0)
        AND species_id = ANY($2::uuid[])
      ORDER BY species_id`,
    [input.playerId, speciesIds],
  );
  return {
    pool: {
      contentReleaseId: input.contentReleaseId,
      areaId: input.areaId,
      entries,
    },
    knownSpeciesIds: known.rows.map((row) => row.species_id),
  };
}

export class PostgresEligibleExpeditionPoolReader {
  public constructor(private readonly pool: Pool) {}

  public async read(
    input: ReadEligibleExpeditionPoolInput,
  ): Promise<EligibleExpeditionPoolRead | null> {
    return withTransaction(
      this.pool,
      (client) => eligibleExpeditionPoolInTransaction(client, input),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
