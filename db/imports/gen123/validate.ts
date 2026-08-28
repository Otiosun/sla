import { createHash } from "node:crypto";
import { Pool } from "pg";
import { gen123Id } from "./ids.js";
import { loadGen123Model } from "./model.js";
import { GEN123_SOURCE, Gen123Source } from "./source.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required for Gen I-III validation");

export interface Gen123ValidationReport {
  readonly ok: boolean;
  readonly releaseId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly coverage: {
    readonly full: readonly string[];
    readonly partial: readonly string[];
    readonly blocked: readonly string[];
  };
  readonly samples: readonly string[];
  readonly source: typeof GEN123_SOURCE;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

export async function validateGen123(markValidated = true): Promise<Gen123ValidationReport> {
  const source = Gen123Source.fromEnvironment();
  const model = await loadGen123Model(source);
  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    const release = await pool.query<{ status: string }>("SELECT status FROM content_releases WHERE id=$1", [releaseId]);
    const status = release.rows[0]?.status;
    if (status === undefined) throw new Error("Gen I-III candidate release does not exist");
    if (!new Set(["DRAFT","VALIDATED"]).has(status)) throw new Error(`Unexpected candidate status ${status}`);

    const countQueries = {
      species: `SELECT count(*)::int AS count FROM pokemon_species_revisions WHERE content_release_id=$1 AND active`,
      forms: `SELECT count(*)::int AS count FROM pokemon_form_revisions WHERE content_release_id=$1 AND active`,
      types: `SELECT count(*)::int AS count FROM pokemon_type_revisions WHERE content_release_id=$1 AND active`,
      moves: `SELECT count(*)::int AS count FROM move_revisions WHERE content_release_id=$1 AND active`,
      abilities: `SELECT count(*)::int AS count FROM ability_revisions WHERE content_release_id=$1 AND active`,
      natures: `SELECT count(*)::int AS count FROM nature_revisions WHERE content_release_id=$1 AND active`,
      items: `SELECT count(*)::int AS count FROM item_revisions WHERE content_release_id=$1 AND active`,
      learnsets: `SELECT count(*)::int AS count FROM move_learnset_entries WHERE content_release_id=$1 AND active`,
      evolutions: `SELECT count(*)::int AS count FROM evolution_rules WHERE content_release_id=$1`,
      activeEvolutions: `SELECT count(*)::int AS count FROM evolution_rules WHERE content_release_id=$1 AND active`,
      regions: `SELECT count(*)::int AS count FROM region_revisions WHERE content_release_id=$1 AND active`,
      areas: `SELECT count(*)::int AS count FROM area_revisions WHERE content_release_id=$1 AND active`,
      connections: `SELECT count(*)::int AS count FROM area_connection_revisions WHERE content_release_id=$1 AND active`,
      encounterTables: `SELECT count(*)::int AS count FROM encounter_table_revisions WHERE content_release_id=$1 AND active`,
      encounters: `SELECT count(*)::int AS count FROM encounter_entries entry JOIN encounter_table_revisions revision ON revision.id=entry.encounter_table_revision_id WHERE revision.content_release_id=$1 AND entry.active`,
      starters: `SELECT count(*)::int AS count FROM starter_options WHERE content_release_id=$1 AND active`,
    } as const;
    const countEntries = await Promise.all(Object.entries(countQueries).map(async ([key, sql]) => {
      const result = await pool.query<{ count: number }>(sql, [releaseId]);
      return [key, result.rows[0]?.count ?? 0] as const;
    }));
    const counts = Object.fromEntries(countEntries) as Record<string, number>;

    assertEqual(counts.species ?? -1, 386, "species revisions");
    assertEqual(counts.forms ?? -1, 386, "required default forms");
    assertEqual(counts.types ?? -1, model.typeRows.length, "types");
    assertEqual(counts.moves ?? -1, model.moves.length, "moves");
    assertEqual(counts.abilities ?? -1, model.abilityRows.length, "abilities");
    assertEqual(counts.natures ?? -1, 25, "natures");
    assertEqual(counts.items ?? -1, model.requiredItemIds.size, "essential/evolution items");
    assertEqual(counts.learnsets ?? -1, model.learnsets.length, "learnsets");
    assertEqual(counts.evolutions ?? -1, model.evolutions.length, "evolution rules");
    assertEqual(counts.regions ?? -1, 3, "regions");
    assertEqual(counts.areas ?? -1, model.locationRows.length, "areas");
    assertEqual(counts.encounterTables ?? -1, new Set(model.encounters.map((entry) => entry.locationId)).size, "encounter tables");
    assertEqual(counts.encounters ?? -1, model.encounters.length, "encounter entries");
    assertEqual(counts.starters ?? -1, 9, "starter options");

    const dex = await pool.query<{ total:number; distinct_dex:number; min_dex:number; max_dex:number; distinct_slug:number }>(
      `SELECT count(*)::int total, count(DISTINCT species.national_dex)::int distinct_dex,
              min(species.national_dex)::int min_dex, max(species.national_dex)::int max_dex,
              count(DISTINCT species.slug)::int distinct_slug
       FROM pokemon_species_revisions revision
       JOIN pokemon_species species ON species.id=revision.species_id
       WHERE revision.content_release_id=$1 AND revision.active`, [releaseId]);
    const dexRow=dex.rows[0];
    if (dexRow===undefined || dexRow.total!==386 || dexRow.distinct_dex!==386 || dexRow.min_dex!==1 || dexRow.max_dex!==386 || dexRow.distinct_slug!==386) throw new Error(`National Dex/slug integrity failed: ${JSON.stringify(dexRow)}`);

    const invalidRanges = await pool.query<{ total:number }>(
      `SELECT (
        (SELECT count(*) FROM pokemon_species_revisions WHERE content_release_id=$1 AND (catch_rate<0 OR catch_rate>255 OR base_exp<0)) +
        (SELECT count(*) FROM pokemon_form_revisions WHERE content_release_id=$1 AND (base_hp<1 OR base_attack<1 OR base_defense<1 OR base_sp_attack<1 OR base_sp_defense<1 OR base_speed<1)) +
        (SELECT count(*) FROM move_revisions WHERE content_release_id=$1 AND (accuracy<0 OR accuracy>100 OR max_pp<=0 OR power<0)) +
        (SELECT count(*) FROM encounter_entries entry JOIN encounter_table_revisions revision ON revision.id=entry.encounter_table_revision_id WHERE revision.content_release_id=$1 AND (entry.weight<=0 OR entry.min_level<1 OR entry.max_level<entry.min_level))
      )::int AS total`, [releaseId]);
    if ((invalidRanges.rows[0]?.total ?? 1)!==0) throw new Error(`Invalid catalog ranges: ${invalidRanges.rows[0]?.total}`);

    const brokenRefs = await pool.query<{ total:number }>(
      `SELECT (
        (SELECT count(*) FROM move_learnset_entries entry LEFT JOIN pokemon_form_revisions form ON form.content_release_id=entry.content_release_id AND form.form_id=entry.form_id LEFT JOIN move_revisions move ON move.content_release_id=entry.content_release_id AND move.move_id=entry.move_id WHERE entry.content_release_id=$1 AND (form.id IS NULL OR move.id IS NULL)) +
        (SELECT count(*) FROM pokemon_form_ability_options option LEFT JOIN pokemon_form_revisions form ON form.content_release_id=option.content_release_id AND form.form_id=option.form_id LEFT JOIN ability_revisions ability ON ability.content_release_id=option.content_release_id AND ability.ability_id=option.ability_id WHERE option.content_release_id=$1 AND (form.id IS NULL OR ability.id IS NULL)) +
        (SELECT count(*) FROM evolution_rules rule LEFT JOIN pokemon_form_revisions from_form ON from_form.content_release_id=rule.content_release_id AND from_form.form_id=rule.from_form_id LEFT JOIN pokemon_form_revisions to_form ON to_form.content_release_id=rule.content_release_id AND to_form.form_id=rule.to_form_id WHERE rule.content_release_id=$1 AND (from_form.id IS NULL OR to_form.id IS NULL))
      )::int total`, [releaseId]);
    if ((brokenRefs.rows[0]?.total ?? 1)!==0) throw new Error(`Broken release references: ${brokenRefs.rows[0]?.total}`);

    const ruleset = await pool.query<{ id:string }>("SELECT default_ruleset_id AS id FROM content_releases WHERE id=$1",[releaseId]);
    const rulesetId=ruleset.rows[0]?.id;
    if(rulesetId===undefined) throw new Error("Candidate ruleset missing");
    const chart = await pool.query<{ count:number }>("SELECT count(*)::int count FROM type_matchups WHERE ruleset_id=$1",[rulesetId]);
    assertEqual(chart.rows[0]?.count ?? -1, model.typeRows.length*model.typeRows.length, "type chart cells");

    const samples: string[]=[];
    for(const nationalDex of [1,25,386]) {
      const expected=model.species.find((entry)=>entry.sourceSpeciesId===nationalDex);
      if(expected===undefined) throw new Error(`Source sample ${nationalDex} missing`);
      const actual=await pool.query<{ catch_rate:number; base_exp:number; base_hp:number; base_attack:number; base_defense:number; base_sp_attack:number; base_sp_defense:number; base_speed:number }>(
        `SELECT species_revision.catch_rate, species_revision.base_exp,
                form.base_hp, form.base_attack, form.base_defense, form.base_sp_attack, form.base_sp_defense, form.base_speed
         FROM pokemon_species species
         JOIN pokemon_species_revisions species_revision ON species_revision.species_id=species.id AND species_revision.content_release_id=$1
         JOIN pokemon_forms identity ON identity.species_id=species.id AND identity.slug=species.slug
         JOIN pokemon_form_revisions form ON form.form_id=identity.id AND form.content_release_id=$1
         WHERE species.national_dex=$2`, [releaseId,nationalDex]);
      const row=actual.rows[0];
      if(row===undefined || row.catch_rate!==expected.captureRate || row.base_exp!==expected.baseExperience || [row.base_hp,row.base_attack,row.base_defense,row.base_sp_attack,row.base_sp_defense,row.base_speed].join(",")!==expected.stats.join(",")) throw new Error(`Species sample mismatch #${nationalDex}`);
      samples.push(`species:#${nationalDex}`);
    }
    for(const sourceMoveId of [33,53]) {
      const expected=model.moves.find((entry)=>entry.sourceId===sourceMoveId);
      if(expected===undefined) throw new Error(`Move source sample ${sourceMoveId} missing`);
      const actual=await pool.query<{ power:number|null; accuracy:number|null; max_pp:number|null }>(
        `SELECT revision.power, revision.accuracy, revision.max_pp FROM move_revisions revision JOIN moves move ON move.id=revision.move_id WHERE revision.content_release_id=$1 AND move.slug=$2`,[releaseId,expected.slug]);
      const row=actual.rows[0];
      if(row===undefined || row.power!==expected.power || row.accuracy!==expected.accuracy || row.max_pp!==expected.pp) throw new Error(`Move sample mismatch ${expected.slug}`);
      samples.push(`move:${expected.slug}`);
    }

    const coverage = {
      full: [
        "species-identities-1-386",
        "default-forms-initial-scope",
        "types-and-type-chart-v1",
        "base-stats-catch-rate-base-exp-metadata",
        "moves-gen1-3",
        "learnsets-version-groups-1-7",
        "natures-25",
        "abilities-gen3-data",
        "evolution-rules-gen1-3-data",
        "essential-items-and-evolution-items",
        "regions-kanto-johto-hoenn",
        "areas-from-pokeapi-locations",
        "encounter-tables-gen1-3-aggregate",
        "starters-kanto-johto-hoenn",
      ],
      partial: [
        "ability-mechanical-effects-explicitly-unsupported-unless-engine-keyed",
        "complex-evolution-mechanics-imported-but-disabled-until-owner-support",
      ],
      blocked: [
        "area-connections-pending-canonical-client-approved-world-graph",
        "publish-initial-release-blocked-until-area-connections-are-canonical",
      ],
    } as const;

    const report: Gen123ValidationReport={ ok:true, releaseId, counts, coverage, samples, source:GEN123_SOURCE };
    if(markValidated && status==="DRAFT") {
      await pool.query(
        `UPDATE content_releases SET status='VALIDATED', validated_at=now(), validation_report=$2::jsonb, content_fingerprint=$3 WHERE id=$1 AND status='DRAFT'`,
        [releaseId,JSON.stringify(report),hash({source:GEN123_SOURCE,counts,coverage,samples})],
      );
    }
    return report;
  } finally {
    await pool.end();
  }
}

if(process.argv[1]?.endsWith("validate.ts")) console.log(JSON.stringify(await validateGen123(true),null,2));
