import { Pool } from "pg";
import { validateGen123Final } from "../imports/gen123/final-validate.js";
import { gen123Id } from "../imports/gen123/ids.js";
import { importGen123 } from "../imports/gen123/import.js";
import { publishGen123 } from "../imports/gen123/publish.js";
import { GEN123_SOURCE } from "../imports/gen123/source.js";
import { applyGen123World } from "../imports/gen123/world.js";
import { GEN123_WORLD_SOURCES } from "../imports/gen123/world-source.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const first = await importGen123();
if (first.status !== "DRAFT")
  throw new Error(`First import must be DRAFT, got ${first.status}`);

const world = await applyGen123World();
if (
  world.status !== "DRAFT" ||
  world.activeAreas < 3 ||
  world.topologyAreas < 3 ||
  world.connections < 1
)
  throw new Error(`World topology was not applied: ${JSON.stringify(world)}`);

const report = await validateGen123Final(true);
if (!report.ok || report.coverage.blocked.length !== 0)
  throw new Error("Final Gen I-III validation did not close all Phase 15 blockers");
if (!report.coverage.full.includes("area-connections-pinned-pret-topology-v1"))
  throw new Error("Final coverage lost canonical world topology evidence");
if (
  !report.coverage.full.includes(
    "encounter-only-source-buckets-preserved-without-fake-travel-edges",
  )
)
  throw new Error("Final coverage lost encounter-only bucket invariant");
if (JSON.stringify(report.encounterOnlyAreas) !== JSON.stringify(world.encounterOnlyAreas))
  throw new Error("World and final validator disagree on encounter-only areas");

const published = await publishGen123();
if (
  published.releaseStatus !== "PUBLISHED" ||
  published.rulesetStatus !== "PUBLISHED"
)
  throw new Error("Phase 15 candidate did not publish");

const releaseId = gen123Id("release:gen123-production-candidate-v1");
if (published.activeReleaseId === releaseId)
  throw new Error("Phase 15 publication must not activate the candidate");

const second = await importGen123();
if (second.status !== "PUBLISHED")
  throw new Error(`Re-run must reuse PUBLISHED release, got ${second.status}`);
const secondWorld = await applyGen123World();
if (
  secondWorld.status !== "PUBLISHED" ||
  secondWorld.connections !== world.connections ||
  secondWorld.activeAreas !== world.activeAreas
)
  throw new Error("Published world verification changed on re-run");
const secondReport = await validateGen123Final(false);
if (JSON.stringify(secondReport.counts) !== JSON.stringify(report.counts))
  throw new Error("Published validation counts changed on re-run");
const secondPublish = await publishGen123();
if (
  secondPublish.releaseStatus !== "PUBLISHED" ||
  secondPublish.activeReleaseId !== published.activeReleaseId
)
  throw new Error("Publication re-run is not idempotent");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const row = await pool.query<{
    release_status: string;
    ruleset_status: string;
    source_commit: string | null;
    blocked: unknown;
    active_release_id: string | null;
  }>(
    `SELECT release.status release_status,
            ruleset.status ruleset_status,
            release.validation_report #>> '{source,commit}' source_commit,
            release.validation_report #> '{coverage,blocked}' blocked,
            (SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE') active_release_id
       FROM content_releases release
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE release.id=$1`,
    [releaseId],
  );
  const state = row.rows[0];
  if (state?.release_status !== "PUBLISHED" || state.ruleset_status !== "PUBLISHED")
    throw new Error("Database lifecycle state is not PUBLISHED");
  if (state.source_commit !== GEN123_SOURCE.commit)
    throw new Error("Final validation report lost PokeAPI provenance");
  if (JSON.stringify(state.blocked) !== "[]")
    throw new Error(
      `Final validation report still has blockers: ${JSON.stringify(state.blocked)}`,
    );
  if (state.active_release_id === releaseId)
    throw new Error("Published candidate unexpectedly became ACTIVE");

  console.log(
    JSON.stringify(
      {
        phase: 15,
        status: "PUBLISHED_NOT_ACTIVE",
        releaseId,
        activeAreas: report.counts.areas,
        topologyAreas: report.topologyAreaCount,
        encounterOnlyAreas: report.encounterOnlyAreas,
        connections: report.counts.connections,
        source: GEN123_SOURCE,
        worldSources: GEN123_WORLD_SOURCES,
        worldSourceLocationCounts: report.worldSourceLocationCounts,
        worldSourceEdgeCounts: report.worldSourceEdgeCounts,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
