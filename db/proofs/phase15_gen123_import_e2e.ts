import { Pool } from "pg";
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
  const sourceCommit = await pool.query<{ source_commit: string | null }>(
    `SELECT validation_report #>> '{source,commit}' AS source_commit FROM content_releases WHERE id=$1`,
    [releaseId],
  );
  if (sourceCommit.rows[0]?.source_commit !== GEN123_SOURCE.commit)
    throw new Error("Validation report lost pinned source provenance");
  console.log(
    `Phase 15 Gen I-III import proof complete: candidate ${releaseId}, ${report.counts.species} species, ${report.counts.moves} moves, ${report.counts.areas} areas; connections/publish intentionally blocked`,
  );
} finally {
  await pool.end();
}
