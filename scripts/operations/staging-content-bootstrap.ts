import { spawn } from "node:child_process";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { gen123Id } from "../../db/imports/gen123/ids.js";

export const STAGING_GEN123_RELEASE_ID = gen123Id("release:gen123-production-candidate-v1");

export type StagingContentBootstrapPlan =
  | "SEED_BASELINE_AND_PROMOTE"
  | "PROMOTE_CANDIDATE"
  | "VERIFY_ACTIVE_CANDIDATE";

type ReleaseStatus = "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";

export interface StagingContentReleaseState {
  readonly id: string;
  readonly releaseNo: number;
  readonly status: ReleaseStatus;
}

export interface StagingContentBootstrapState {
  readonly activeRelease: StagingContentReleaseState | null;
  readonly phase4Release: StagingContentReleaseState | null;
  readonly candidateRelease: StagingContentReleaseState | null;
  readonly unexpectedReleaseCount: number;
  readonly unexpectedRulesetCount: number;
}

function unexpectedState(state: StagingContentBootstrapState): never {
  throw new Error(`unexpected staging catalog state: ${JSON.stringify(state)}`);
}

export function planStagingContentBootstrap(
  state: StagingContentBootstrapState,
): StagingContentBootstrapPlan {
  if (state.unexpectedReleaseCount !== 0 || state.unexpectedRulesetCount !== 0) {
    return unexpectedState(state);
  }

  const { activeRelease, phase4Release, candidateRelease } = state;
  if (activeRelease === null && phase4Release === null && candidateRelease === null) {
    return "SEED_BASELINE_AND_PROMOTE";
  }

  if (
    activeRelease !== null &&
    phase4Release !== null &&
    activeRelease.id === phase4Release.id &&
    phase4Release.releaseNo === 1 &&
    phase4Release.status === "PUBLISHED" &&
    (candidateRelease === null ||
      (candidateRelease.id === STAGING_GEN123_RELEASE_ID &&
        candidateRelease.releaseNo === 15001 &&
        new Set<ReleaseStatus>(["DRAFT", "VALIDATED", "PUBLISHED"]).has(candidateRelease.status)))
  ) {
    return "PROMOTE_CANDIDATE";
  }

  if (
    activeRelease !== null &&
    phase4Release !== null &&
    candidateRelease !== null &&
    activeRelease.id === STAGING_GEN123_RELEASE_ID &&
    activeRelease.releaseNo === 15001 &&
    activeRelease.status === "PUBLISHED" &&
    candidateRelease.id === STAGING_GEN123_RELEASE_ID &&
    candidateRelease.releaseNo === 15001 &&
    candidateRelease.status === "PUBLISHED" &&
    phase4Release.releaseNo === 1 &&
    phase4Release.status === "PUBLISHED"
  ) {
    return "VERIFY_ACTIVE_CANDIDATE";
  }

  return unexpectedState(state);
}

interface ReleaseRow {
  readonly id: string;
  readonly release_no: number;
  readonly status: ReleaseStatus;
  readonly ruleset_key: string;
  readonly ruleset_version: number;
}

function releaseState(row: ReleaseRow | undefined): StagingContentReleaseState | null {
  return row === undefined
    ? null
    : {
        id: row.id,
        releaseNo: row.release_no,
        status: row.status,
      };
}

async function readState(client: PoolClient): Promise<StagingContentBootstrapState> {
  const releases = await client.query<ReleaseRow>(
    `SELECT release.id,
            release.release_no::int,
            release.status,
            ruleset.key AS ruleset_key,
            ruleset.version AS ruleset_version
       FROM content_releases release
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
      WHERE release.release_no = 1
         OR (release.id = $1 AND release.release_no = 15001)
      ORDER BY release.release_no`,
    [STAGING_GEN123_RELEASE_ID],
  );
  const phase4Row = releases.rows.find((row) => row.release_no === 1);
  const candidateRow = releases.rows.find(
    (row) => row.release_no === 15001 && row.id === STAGING_GEN123_RELEASE_ID,
  );

  const active = await client.query<ReleaseRow>(
    `SELECT release.id,
            release.release_no::int,
            release.status,
            ruleset.key AS ruleset_key,
            ruleset.version AS ruleset_version
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
      WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  if (active.rows.length > 1) {
    throw new Error("unexpected staging catalog state: multiple ACTIVE rows");
  }

  const unexpectedReleases = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM content_releases
      WHERE release_no <> 1
        AND NOT (id = $1 AND release_no = 15001)`,
    [STAGING_GEN123_RELEASE_ID],
  );
  const unexpectedRulesets = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM rulesets
      WHERE NOT (key = 'phase4-core-v1' AND version = 1)
        AND NOT (key = 'gen123-core' AND version = 1)`,
  );

  let rulesetMismatchCount = 0;
  if (
    phase4Row !== undefined &&
    (phase4Row.ruleset_key !== "phase4-core-v1" || phase4Row.ruleset_version !== 1)
  ) {
    rulesetMismatchCount += 1;
  }
  if (
    candidateRow !== undefined &&
    (candidateRow.ruleset_key !== "gen123-core" || candidateRow.ruleset_version !== 1)
  ) {
    rulesetMismatchCount += 1;
  }

  return {
    activeRelease: releaseState(active.rows[0]),
    phase4Release: releaseState(phase4Row),
    candidateRelease: releaseState(candidateRow),
    unexpectedReleaseCount: unexpectedReleases.rows[0]?.count ?? 0,
    unexpectedRulesetCount: (unexpectedRulesets.rows[0]?.count ?? 0) + rulesetMismatchCount,
  };
}

async function verifySchema(pool: Pool): Promise<void> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  try {
    await verifyAppliedMigrations(client, migrations, true);
  } finally {
    client.release();
  }
}

async function runPhase4Seed(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "run", "db:seed:phase4"], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(new Error(`db:seed:phase4 failed: code=${String(code)} signal=${String(signal)}`));
      }
    });
  });
}

async function currentState(pool: Pool): Promise<StagingContentBootstrapState> {
  const client = await pool.connect();
  try {
    return await readState(client);
  } finally {
    client.release();
  }
}

function requireDeploymentEnvironment(): {
  readonly databaseUrl: string;
  readonly revision: string;
} {
  if (process.env.APP_ENV !== "staging") throw new Error("APP_ENV must be staging");
  const revision = process.env.DEPLOY_REVISION;
  if (revision === undefined || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("DEPLOY_REVISION must be a full 40-character Git SHA");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  return { databaseUrl, revision };
}

function assertFinalReport(report: {
  readonly coverage: { readonly blocked: readonly string[] };
  readonly counts: Readonly<Record<string, number>>;
}): void {
  if (report.coverage.blocked.length !== 0) {
    throw new Error(
      `final Gen I-III validation still has blockers: ${report.coverage.blocked.join(",")}`,
    );
  }
  if (
    report.counts.species !== 386 ||
    report.counts.forms !== 386 ||
    report.counts.starters !== 9
  ) {
    throw new Error(
      `final Gen I-III validation counts are unexpected: ${JSON.stringify(report.counts)}`,
    );
  }
}

export async function bootstrapStagingContent(): Promise<{
  readonly releaseId: string;
  readonly replayed: boolean;
  readonly species: number;
}> {
  const { databaseUrl, revision } = requireDeploymentEnvironment();
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await verifySchema(pool);
    let state = await currentState(pool);
    let plan = planStagingContentBootstrap(state);

    if (plan === "SEED_BASELINE_AND_PROMOTE") {
      await runPhase4Seed();
      state = await currentState(pool);
      plan = planStagingContentBootstrap(state);
      if (plan !== "PROMOTE_CANDIDATE") {
        throw new Error(
          `unexpected staging catalog state after Phase 4 seed: ${JSON.stringify(state)}`,
        );
      }
    }

    const { validateGen123Final } = await import("../../db/imports/gen123/final-validate.js");

    if (plan === "VERIFY_ACTIVE_CANDIDATE") {
      const replayReport = await validateGen123Final(false);
      assertFinalReport(replayReport);
      const verified = await currentState(pool);
      if (planStagingContentBootstrap(verified) !== "VERIFY_ACTIVE_CANDIDATE") {
        throw new Error(
          `unexpected staging catalog state during replay verification: ${JSON.stringify(verified)}`,
        );
      }
      console.log(
        JSON.stringify({
          event: "staging.content.bootstrap.complete",
          revision,
          releaseId: STAGING_GEN123_RELEASE_ID,
          replayed: true,
          species: replayReport.counts.species,
        }),
      );
      return {
        releaseId: STAGING_GEN123_RELEASE_ID,
        replayed: true,
        species: replayReport.counts.species ?? 386,
      };
    }

    const [{ importGen123 }, { applyGen123World }, { publishGen123 }] = await Promise.all([
      import("../../db/imports/gen123/import.js"),
      import("../../db/imports/gen123/world.js"),
      import("../../db/imports/gen123/publish.js"),
    ]);

    await importGen123();
    await applyGen123World();
    const report = await validateGen123Final(true);
    assertFinalReport(report);

    const published = await publishGen123();
    if (published.releaseStatus !== "PUBLISHED" || published.rulesetStatus !== "PUBLISHED") {
      throw new Error(
        `Gen I-III publication returned unexpected state: ${JSON.stringify(published)}`,
      );
    }
    if (published.activeReleaseId === STAGING_GEN123_RELEASE_ID) {
      throw new Error(
        "unexpected staging catalog state: candidate became ACTIVE before explicit activation",
      );
    }

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const activated = await catalog.activateRelease(STAGING_GEN123_RELEASE_ID);
    if (!activated.ok) {
      throw new Error(
        `Gen I-III activation failed [${activated.error.code}]: ${activated.error.message}`,
      );
    }

    const finalState = await currentState(pool);
    if (planStagingContentBootstrap(finalState) !== "VERIFY_ACTIVE_CANDIDATE") {
      throw new Error(
        `unexpected staging catalog state after activation: ${JSON.stringify(finalState)}`,
      );
    }
    const finalReport = await validateGen123Final(false);
    assertFinalReport(finalReport);

    console.log(
      JSON.stringify({
        event: "staging.content.bootstrap.complete",
        revision,
        releaseId: STAGING_GEN123_RELEASE_ID,
        replayed: false,
        species: finalReport.counts.species,
      }),
    );
    return {
      releaseId: STAGING_GEN123_RELEASE_ID,
      replayed: false,
      species: finalReport.counts.species ?? 386,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("staging-content-bootstrap.ts")) {
  await bootstrapStagingContent();
}
