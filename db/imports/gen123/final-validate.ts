import { Pool } from "pg";
import {
  fingerprintCatalog,
  fingerprintRuleset,
} from "../../../src/modules/catalog/fingerprint.js";
import {
  ConnectionAccessRuleSchema,
  WorldAreaConfigSchema,
} from "../../../src/modules/catalog/world-contracts.js";
import { PostgresCatalogRepository } from "../../../src/platform/catalog/postgres-catalog-repository.js";
import { gen123Id } from "./ids.js";
import { loadGen123Model, type Gen123Model } from "./model.js";
import {
  GEN123_SOURCE,
  Gen123Source,
  requiredInt,
  requiredText,
} from "./source.js";
import {
  GEN123_WORLD_SOURCES,
  loadGen123WorldTopology,
  type Gen123WorldTopology,
} from "./world-source.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined)
  throw new Error("DATABASE_URL is required for final Gen I-III validation");

export interface Gen123FinalValidationReport {
  readonly ok: true;
  readonly releaseId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly topologyAreaCount: number;
  readonly encounterOnlyAreas: readonly string[];
  readonly coverage: {
    readonly full: readonly string[];
    readonly partial: readonly string[];
    readonly blocked: readonly string[];
  };
  readonly samples: readonly string[];
  readonly source: typeof GEN123_SOURCE;
  readonly worldSources: typeof GEN123_WORLD_SOURCES;
  readonly worldSourceLocationCounts: Readonly<Record<string, number>>;
  readonly worldSourceEdgeCounts: Readonly<Record<string, number>>;
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function sourceScopedAreas(
  model: Gen123Model,
  topology: Gen123WorldTopology,
): {
  readonly activeSlugs: ReadonlySet<string>;
  readonly encounterOnlySlugs: ReadonlySet<string>;
} {
  const encounterLocationIds = new Set(model.encounters.map((entry) => entry.locationId));
  const encounterSlugs = new Set<string>();
  for (const row of model.locationRows) {
    const locationId = requiredInt(row, "id");
    if (encounterLocationIds.has(locationId)) encounterSlugs.add(requiredText(row, "identifier"));
  }
  const activeSlugs = new Set([...topology.locationSlugs, ...encounterSlugs]);
  const encounterOnlySlugs = new Set(
    [...encounterSlugs].filter((slug) => !topology.locationSlugs.has(slug)),
  );
  return { activeSlugs, encounterOnlySlugs };
}

export async function validateGen123Final(
  markValidated = true,
): Promise<Gen123FinalValidationReport> {
  const source = Gen123Source.fromEnvironment();
  const model = await loadGen123Model(source);
  const topology = await loadGen123WorldTopology(model.locationRows);
  const { activeSlugs, encounterOnlySlugs } = sourceScopedAreas(model, topology);
  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  try {
    const releaseResult = await pool.query<{ status: string; default_ruleset_id: string }>(
      "SELECT status, default_ruleset_id FROM content_releases WHERE id=$1",
      [releaseId],
    );
    const release = releaseResult.rows[0];
    if (release === undefined) throw new Error("Gen I-III candidate release does not exist");
    if (!["DRAFT", "VALIDATED", "PUBLISHED"].includes(release.status))
      throw new Error(`Unexpected candidate status ${release.status}`);

    const countQueries = {
      species:
        "SELECT count(*)::int count FROM pokemon_species_revisions WHERE content_release_id=$1 AND active",
      forms:
        "SELECT count(*)::int count FROM pokemon_form_revisions WHERE content_release_id=$1 AND active",
      types:
        "SELECT count(*)::int count FROM pokemon_type_revisions WHERE content_release_id=$1 AND active",
      moves:
        "SELECT count(*)::int count FROM move_revisions WHERE content_release_id=$1 AND active",
      abilities:
        "SELECT count(*)::int count FROM ability_revisions WHERE content_release_id=$1 AND active",
      natures:
        "SELECT count(*)::int count FROM nature_revisions WHERE content_release_id=$1 AND active",
      items:
        "SELECT count(*)::int count FROM item_revisions WHERE content_release_id=$1 AND active",
      learnsets:
        "SELECT count(*)::int count FROM move_learnset_entries WHERE content_release_id=$1 AND active",
      evolutions: "SELECT count(*)::int count FROM evolution_rules WHERE content_release_id=$1",
      regions:
        "SELECT count(*)::int count FROM region_revisions WHERE content_release_id=$1 AND active",
      areas: "SELECT count(*)::int count FROM area_revisions WHERE content_release_id=$1 AND active",
      connections:
        "SELECT count(*)::int count FROM area_connection_revisions WHERE content_release_id=$1 AND active",
      encounterTables:
        "SELECT count(*)::int count FROM encounter_table_revisions WHERE content_release_id=$1 AND active",
      encounters:
        "SELECT count(*)::int count FROM encounter_entries entry JOIN encounter_table_revisions revision ON revision.id=entry.encounter_table_revision_id WHERE revision.content_release_id=$1 AND entry.active",
      starters: "SELECT count(*)::int count FROM starter_options WHERE content_release_id=$1 AND active",
    } as const;
    const counts = Object.fromEntries(
      await Promise.all(
        Object.entries(countQueries).map(async ([key, sql]) => {
          const result = await pool.query<{ count: number }>(sql, [releaseId]);
          return [key, result.rows[0]?.count ?? 0] as const;
        }),
      ),
    ) as Record<string, number>;

    assertEqual(counts.species ?? -1, 386, "species revisions");
    assertEqual(counts.forms ?? -1, 386, "default forms");
    assertEqual(counts.types ?? -1, model.typeRows.length, "types");
    assertEqual(counts.moves ?? -1, model.moves.length, "moves");
    assertEqual(counts.abilities ?? -1, model.abilityRows.length, "abilities");
    assertEqual(counts.natures ?? -1, 25, "natures");
    assertEqual(counts.items ?? -1, model.requiredItemIds.size, "essential items");
    assertEqual(counts.learnsets ?? -1, model.learnsets.length, "learnsets");
    assertEqual(counts.evolutions ?? -1, model.evolutions.length, "evolutions");
    assertEqual(counts.regions ?? -1, 3, "regions");
    assertEqual(counts.areas ?? -1, activeSlugs.size, "source-scoped active areas");
    assertEqual(counts.connections ?? -1, topology.edges.length, "canonical world connections");
    assertEqual(
      counts.encounterTables ?? -1,
      new Set(model.encounters.map((entry) => entry.locationId)).size,
      "encounter tables",
    );
    assertEqual(counts.encounters ?? -1, model.encounters.length, "encounter entries");
    assertEqual(counts.starters ?? -1, 9, "starter options");

    const dex = await pool.query<{
      total: number;
      distinct_dex: number;
      min_dex: number;
      max_dex: number;
    }>(
      `SELECT count(*)::int total, count(DISTINCT species.national_dex)::int distinct_dex,
              min(species.national_dex)::int min_dex, max(species.national_dex)::int max_dex
         FROM pokemon_species_revisions revision
         JOIN pokemon_species species ON species.id=revision.species_id
        WHERE revision.content_release_id=$1 AND revision.active`,
      [releaseId],
    );
    const dexRow = dex.rows[0];
    if (
      dexRow === undefined ||
      dexRow.total !== 386 ||
      dexRow.distinct_dex !== 386 ||
      dexRow.min_dex !== 1 ||
      dexRow.max_dex !== 386
    )
      throw new Error(`National Dex integrity failed: ${JSON.stringify(dexRow)}`);

    const activeAreas = await pool.query<{ slug: string; data: unknown }>(
      `SELECT area.slug, revision.data
         FROM area_revisions revision
         JOIN areas area ON area.id=revision.area_id
        WHERE revision.content_release_id=$1 AND revision.active
        ORDER BY area.slug`,
      [releaseId],
    );
    const actualAreaSlugs = new Set(activeAreas.rows.map((row) => row.slug));
    if (actualAreaSlugs.size !== activeSlugs.size)
      throw new Error(`Active area set size mismatch: ${actualAreaSlugs.size} vs ${activeSlugs.size}`);
    for (const slug of activeSlugs)
      if (!actualAreaSlugs.has(slug)) throw new Error(`Missing source-scoped active area ${slug}`);
    for (const row of activeAreas.rows) {
      const parsed = WorldAreaConfigSchema.safeParse(row.data);
      if (!parsed.success)
        throw new Error(`Invalid world area config ${row.slug}: ${parsed.error.message}`);
    }

    const actualEdges = await pool.query<{
      from_slug: string;
      to_slug: string;
      connection_key: string;
      access_rule: unknown;
    }>(
      `SELECT source.slug from_slug, destination.slug to_slug,
              identity.connection_key, revision.access_rule
         FROM area_connection_revisions revision
         JOIN area_connections identity ON identity.id=revision.connection_id
         JOIN areas source ON source.id=identity.from_area_id
         JOIN areas destination ON destination.id=identity.to_area_id
        WHERE revision.content_release_id=$1 AND revision.active
        ORDER BY source.slug,destination.slug,identity.connection_key`,
      [releaseId],
    );
    const expectedEdgeKeys = new Set(
      topology.edges.map((edge) => `${edge.fromSlug}:${edge.toSlug}:${edge.connectionKey}`),
    );
    const actualEdgeKeys = new Set(
      actualEdges.rows.map((edge) => `${edge.from_slug}:${edge.to_slug}:${edge.connection_key}`),
    );
    if (actualEdgeKeys.size !== expectedEdgeKeys.size)
      throw new Error(
        `World edge key count mismatch: ${actualEdgeKeys.size} vs ${expectedEdgeKeys.size}`,
      );
    for (const key of expectedEdgeKeys)
      if (!actualEdgeKeys.has(key)) throw new Error(`Missing canonical world edge ${key}`);
    for (const edge of actualEdges.rows) {
      const parsed = ConnectionAccessRuleSchema.safeParse(edge.access_rule);
      if (!parsed.success)
        throw new Error(`Invalid connection access rule ${edge.from_slug}->${edge.to_slug}`);
    }

    const degree = new Map<string, number>();
    for (const edge of topology.edges) {
      degree.set(edge.fromSlug, (degree.get(edge.fromSlug) ?? 0) + 1);
      degree.set(edge.toSlug, (degree.get(edge.toSlug) ?? 0) + 1);
    }
    for (const start of ["pallet-town", "new-bark-town", "littleroot-town"])
      if ((degree.get(start) ?? 0) === 0) throw new Error(`Starting area ${start} is disconnected`);

    const encounterAreas = await pool.query<{ slug: string }>(
      `SELECT DISTINCT area.slug
         FROM encounter_table_revisions revision
         JOIN encounter_tables table_identity ON table_identity.id=revision.encounter_table_id
         JOIN areas area ON area.id=table_identity.area_id
        WHERE revision.content_release_id=$1 AND revision.active`,
      [releaseId],
    );
    for (const row of encounterAreas.rows) {
      if (!activeSlugs.has(row.slug))
        throw new Error(`Active encounter area ${row.slug} is outside source-scoped active areas`);
      if (!topology.locationSlugs.has(row.slug) && !encounterOnlySlugs.has(row.slug))
        throw new Error(`Encounter area ${row.slug} is neither navigable nor an encounter-only bucket`);
    }

    const brokenRefs = await pool.query<{ total: number }>(
      `SELECT (
        (SELECT count(*) FROM move_learnset_entries entry LEFT JOIN pokemon_form_revisions form ON form.content_release_id=entry.content_release_id AND form.form_id=entry.form_id LEFT JOIN move_revisions move ON move.content_release_id=entry.content_release_id AND move.move_id=entry.move_id WHERE entry.content_release_id=$1 AND (form.id IS NULL OR move.id IS NULL OR move.max_pp IS NULL)) +
        (SELECT count(*) FROM area_connection_revisions revision JOIN area_connections identity ON identity.id=revision.connection_id LEFT JOIN area_revisions source ON source.content_release_id=revision.content_release_id AND source.area_id=identity.from_area_id LEFT JOIN area_revisions destination ON destination.content_release_id=revision.content_release_id AND destination.area_id=identity.to_area_id WHERE revision.content_release_id=$1 AND revision.active AND (source.id IS NULL OR destination.id IS NULL OR NOT source.active OR NOT destination.active))
      )::int total`,
      [releaseId],
    );
    if ((brokenRefs.rows[0]?.total ?? 1) !== 0)
      throw new Error(`Broken final release references: ${brokenRefs.rows[0]?.total}`);

    const chart = await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM type_matchups WHERE ruleset_id=$1",
      [release.default_ruleset_id],
    );
    assertEqual(
      chart.rows[0]?.count ?? -1,
      model.typeRows.length * model.typeRows.length,
      "type chart cells",
    );

    const samples: string[] = [];
    for (const nationalDex of [1, 25, 386]) {
      const expected = model.species.find((entry) => entry.sourceSpeciesId === nationalDex);
      if (expected === undefined) throw new Error(`Missing source species sample #${nationalDex}`);
      const actual = await pool.query<{ catch_rate: number; base_exp: number }>(
        `SELECT revision.catch_rate, revision.base_exp
           FROM pokemon_species_revisions revision
           JOIN pokemon_species species ON species.id=revision.species_id
          WHERE revision.content_release_id=$1 AND species.national_dex=$2`,
        [releaseId, nationalDex],
      );
      const row = actual.rows[0];
      if (row?.catch_rate !== expected.captureRate || row?.base_exp !== expected.baseExperience)
        throw new Error(`Species source parity failed #${nationalDex}`);
      samples.push(`species:#${nationalDex}`);
    }
    for (const slug of ["pallet-town", "new-bark-town", "littleroot-town"])
      samples.push(`world:${slug}:degree=${degree.get(slug) ?? 0}`);

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
        "areas-source-scoped-gen1-3",
        "area-connections-pinned-pret-topology-v1",
        "encounter-only-source-buckets-preserved-without-fake-travel-edges",
        "encounter-tables-gen1-3-aggregate",
        "starters-kanto-johto-hoenn",
        "initial-release-ready-for-publication",
      ],
      partial: [
        "source-null-pp-never-fabricated-and-nonexecutable-if-in-scope",
        "ability-mechanical-effects-explicitly-unsupported-unless-engine-keyed",
        "complex-evolution-mechanics-imported-but-disabled-until-owner-support",
        "world-access-rules-are-open-topology-only-no-story-gates-invented",
      ],
      blocked: [],
    } as const;

    const report: Gen123FinalValidationReport = {
      ok: true,
      releaseId,
      counts,
      topologyAreaCount: topology.locationSlugs.size,
      encounterOnlyAreas: [...encounterOnlySlugs].sort(),
      coverage,
      samples,
      source: GEN123_SOURCE,
      worldSources: GEN123_WORLD_SOURCES,
      worldSourceLocationCounts: topology.sourceLocationCounts,
      worldSourceEdgeCounts: topology.sourceEdgeCounts,
    };

    const repository = new PostgresCatalogRepository(pool);
    const rulesetSnapshot = await repository.read((transaction) =>
      transaction.loadRuleset(release.default_ruleset_id),
    );
    if (rulesetSnapshot === null)
      throw new Error("Unable to load canonical ruleset snapshot for fingerprinting");
    const rulesetFingerprint = fingerprintRuleset(rulesetSnapshot);

    if (markValidated && release.status === "DRAFT") {
      const rulesetUpdate = await pool.query(
        "UPDATE rulesets SET config_fingerprint=$2 WHERE id=$1 AND status='VALIDATED'",
        [release.default_ruleset_id, rulesetFingerprint],
      );
      if (rulesetUpdate.rowCount !== 1) throw new Error("Ruleset fingerprint update failed");

      const catalogSnapshot = await repository.read((transaction) =>
        transaction.loadCatalogSnapshot(releaseId),
      );
      if (catalogSnapshot === null)
        throw new Error("Unable to load canonical catalog snapshot for fingerprinting");
      const contentFingerprint = fingerprintCatalog(catalogSnapshot);
      const releaseUpdate = await pool.query(
        `UPDATE content_releases
            SET status='VALIDATED', validated_at=now(), validation_report=$2::jsonb,
                content_fingerprint=$3
          WHERE id=$1 AND status='DRAFT'`,
        [releaseId, JSON.stringify(report), contentFingerprint],
      );
      if (releaseUpdate.rowCount !== 1) throw new Error("Final release validation transition failed");
    }

    return report;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("final-validate.ts"))
  console.log(JSON.stringify(await validateGen123Final(true), null, 2));
