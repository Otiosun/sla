import { Pool } from "pg";
import { parseEncounterConditions } from "../../src/modules/catalog/encounter-contracts.js";
import { gen123Id } from "../imports/gen123/ids.js";
import { importGen123 } from "../imports/gen123/import.js";
import { GEN123_SOURCE } from "../imports/gen123/source.js";
import { validateGen123 } from "../imports/gen123/validate.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const first = await importGen123();
if (first.status !== "DRAFT")
  throw new Error(`First import must produce DRAFT candidate, got ${first.status}`);
const report = await validateGen123(true);
if (!report.ok) throw new Error("Gen I-III validation failed");
if (report.counts.species !== 386 || report.counts.starters !== 9)
  throw new Error(`Coverage counts failed: ${JSON.stringify(report.counts)}`);
if (
  !report.coverage.blocked.includes(
    "area-connections-pending-canonical-client-approved-world-graph",
  )
)
  throw new Error("World connection blocker must remain explicit");
if (
  !report.coverage.partial.includes(
    "source-null-pp-never-fabricated-and-nonexecutable-if-in-scope",
  )
)
  throw new Error("Source-null PP invariant must remain explicit in coverage");

const second = await importGen123();
if (second.status !== "VALIDATED")
  throw new Error(`Re-run must verify/reuse VALIDATED candidate, got ${second.status}`);
const secondReport = await validateGen123(false);
if (JSON.stringify(secondReport.counts) !== JSON.stringify(report.counts))
  throw new Error("Re-run changed catalog counts");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const release = await pool.query<{ status: string; validation_report: unknown }>(
    "SELECT status, validation_report FROM content_releases WHERE id=$1",
    [releaseId],
  );
  if (release.rows[0]?.status !== "VALIDATED")
    throw new Error("Candidate must stop at VALIDATED, never auto-publish");
  const active = await pool.query<{ content_release_id: string }>(
    "SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE'",
  );
  if (active.rows[0]?.content_release_id === releaseId)
    throw new Error("Phase 15 candidate unexpectedly replaced ACTIVE release");
  const candidateRuleset = await pool.query<{ status: string }>(
    "SELECT ruleset.status FROM content_releases release JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id WHERE release.id=$1",
    [releaseId],
  );
  if (candidateRuleset.rows[0]?.status !== "VALIDATED")
    throw new Error(
      `Candidate ruleset must stop at VALIDATED, got ${candidateRuleset.rows[0]?.status ?? "missing"}`,
    );

  const clefairyType = await pool.query<{ type_slug: string }>(
    `SELECT type.slug AS type_slug
     FROM pokemon_species species
     JOIN pokemon_forms form ON form.species_id=species.id AND form.slug=species.slug
     JOIN pokemon_form_revisions revision
       ON revision.form_id=form.id AND revision.content_release_id=$1
     JOIN pokemon_types type ON type.id=revision.type1_id
     WHERE species.national_dex=35`,
    [releaseId],
  );
  if (clefairyType.rows[0]?.type_slug !== "fairy")
    throw new Error(
      `Modern v1 taxonomy lost Clefairy Fairy typing: ${clefairyType.rows[0]?.type_slug ?? "missing"}`,
    );

  const nullPp = await pool.query<{ moves: number; learnsets: number }>(
    `SELECT
       (SELECT count(*)::int FROM move_revisions
         WHERE content_release_id=$1 AND active AND max_pp IS NULL) AS moves,
       (SELECT count(*)::int
          FROM move_learnset_entries learnset
          JOIN move_revisions move
            ON move.content_release_id=learnset.content_release_id
           AND move.move_id=learnset.move_id
         WHERE learnset.content_release_id=$1
           AND learnset.active
           AND move.max_pp IS NULL) AS learnsets`,
    [releaseId],
  );
  if ((nullPp.rows[0]?.learnsets ?? -1) !== 0)
    throw new Error("Executable learnsets must never reference a move with unknown PP");

  const conditionRows = await pool.query<{ conditions: unknown }>(
    `SELECT conditions FROM encounter_table_revisions WHERE content_release_id=$1
     UNION ALL
     SELECT entry.conditions
       FROM encounter_entries entry
       JOIN encounter_table_revisions revision
         ON revision.id=entry.encounter_table_revision_id
      WHERE revision.content_release_id=$1`,
    [releaseId],
  );
  if (conditionRows.rows.length < 1)
    throw new Error("Candidate contains no encounter conditions to validate");
  for (const [index, row] of conditionRows.rows.entries()) {
    const parsed = parseEncounterConditions(row.conditions);
    if (!parsed.success)
      throw new Error(`Imported encounter conditions are runtime-invalid at row ${index}`);
  }

  const sourceCommit = await pool.query<{ source_commit: string | null }>(
    `SELECT validation_report #>> '{source,commit}' AS source_commit FROM content_releases WHERE id=$1`,
    [releaseId],
  );
  if (sourceCommit.rows[0]?.source_commit !== GEN123_SOURCE.commit)
    throw new Error("Validation report lost pinned source provenance");
  console.log(
    `Phase 15 Gen I-III import proof complete: candidate ${releaseId}, ${report.counts.species} species, ${report.counts.moves} moves, ${report.counts.areas} areas, ${nullPp.rows[0]?.moves ?? 0} retained null-PP moves; connections/publish intentionally blocked`,
  );
} finally {
  await pool.end();
}
