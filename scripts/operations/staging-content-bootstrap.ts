import { spawn } from "node:child_process";
import { Pool, type PoolClient } from "pg";
import { gen123Id } from "../../db/imports/gen123/ids.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import {
  assertZhouliaExclusiveRelease,
  reconcileZhouliaExclusiveRelease,
  type ZhouliaStarterOptionInput,
} from "../../src/platform/world/postgres-zhoulia-exclusive-release.js";

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
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE release.release_no=1
         OR (release.id=$1 AND release.release_no=15001)
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
       JOIN content_releases release ON release.id=pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE pointer.pointer_key='ACTIVE'`,
  );
  if (active.rows.length > 1) {
    throw new Error("unexpected staging catalog state: multiple ACTIVE rows");
  }

  const unexpectedReleases = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM content_releases
      WHERE release_no<>1
        AND NOT (id=$1 AND release_no=15001)`,
    [STAGING_GEN123_RELEASE_ID],
  );
  const unexpectedRulesets = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM rulesets
      WHERE NOT (key='phase4-core-v1' AND version=1)
        AND NOT (key='gen123-core' AND version=1)`,
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
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
      windows
        ? ["/d", "/s", "/c", "pnpm --silent run db:seed:phase4"]
        : ["--silent", "run", "db:seed:phase4"],
      {
        env: process.env,
        stdio: "inherit",
      },
    );
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

function assertGen123SourceReport(report: {
  readonly coverage: { readonly blocked: readonly string[] };
  readonly counts: Readonly<Record<string, number>>;
}): void {
  if (report.coverage.blocked.length !== 0) {
    throw new Error(
      `Gen I-III source validation still has blockers: ${report.coverage.blocked.join(",")}`,
    );
  }
  if (
    report.counts.species !== 386 ||
    report.counts.forms !== 386 ||
    report.counts.starters !== 9
  ) {
    throw new Error(
      `Gen I-III source validation counts are unexpected: ${JSON.stringify(report.counts)}`,
    );
  }
}

async function activeSpeciesCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM pokemon_species_revisions revision
       JOIN content_release_pointers pointer
         ON pointer.content_release_id=revision.content_release_id
      WHERE pointer.pointer_key='ACTIVE'
        AND revision.active=TRUE`,
  );
  return result.rows[0]?.count ?? 0;
}

async function publishCandidate(pool: Pool): Promise<void> {
  const catalog = new CatalogService(new PostgresCatalogRepository(pool));
  const state = await pool.query<{
    release_status: ReleaseStatus;
    ruleset_id: string;
    ruleset_status: ReleaseStatus;
  }>(
    `SELECT release.status AS release_status,
            release.default_ruleset_id AS ruleset_id,
            ruleset.status AS ruleset_status
       FROM content_releases release
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE release.id=$1`,
    [STAGING_GEN123_RELEASE_ID],
  );
  const current = state.rows[0];
  if (current === undefined) throw new Error("staging candidate disappeared before publication");

  if (current.release_status === "DRAFT") {
    const validated = await catalog.validateRelease(STAGING_GEN123_RELEASE_ID);
    if (!validated.ok) {
      throw new Error(
        `Zhoulia candidate validation failed [${validated.error.code}]: ${validated.error.message}`,
      );
    }
  } else if (!["VALIDATED", "PUBLISHED"].includes(current.release_status)) {
    throw new Error(`unexpected candidate status ${current.release_status}`);
  }

  if (current.ruleset_status === "VALIDATED") {
    const rulesetPublished = await catalog.publishRuleset(current.ruleset_id);
    if (!rulesetPublished.ok) {
      throw new Error(
        `Gen I-III ruleset publication failed [${rulesetPublished.error.code}]: ` +
          rulesetPublished.error.message,
      );
    }
  } else if (current.ruleset_status !== "PUBLISHED") {
    throw new Error(`unexpected Gen I-III ruleset status ${current.ruleset_status}`);
  }

  const afterValidation = await pool.query<{ status: ReleaseStatus }>(
    "SELECT status FROM content_releases WHERE id=$1",
    [STAGING_GEN123_RELEASE_ID],
  );
  if (afterValidation.rows[0]?.status === "VALIDATED") {
    const published = await catalog.publishRelease(STAGING_GEN123_RELEASE_ID);
    if (!published.ok) {
      throw new Error(
        `Zhoulia candidate publication failed [${published.error.code}]: ${published.error.message}`,
      );
    }
  } else if (afterValidation.rows[0]?.status !== "PUBLISHED") {
    throw new Error(
      `unexpected release status before activation: ${afterValidation.rows[0]?.status}`,
    );
  }
}

function loadCanonicalZhouliaStarterOptions(): readonly ZhouliaStarterOptionInput[] {
  throw new Error(
    "Canonical Zhoulia starter set is not configured; refusing to infer it from Gen I-III source starters",
  );
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

    // Product policy is deliberately fail-closed here. The Gen I-III importer
    // currently yields nine source starters, but that cardinality is not a Bell
    // Zhoulia product decision and must never be promoted implicitly.
    const canonicalStarterOptions = loadCanonicalZhouliaStarterOptions();

    if (plan === "VERIFY_ACTIVE_CANDIDATE") {
      await assertZhouliaExclusiveRelease(pool, { releaseId: STAGING_GEN123_RELEASE_ID });
      const species = await activeSpeciesCount(pool);
      if (species !== 386) {
        throw new Error(`ACTIVE Zhoulia catalog expected 386 species, got ${species}`);
      }
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
          species,
          world: "zhoulia",
        }),
      );
      return {
        releaseId: STAGING_GEN123_RELEASE_ID,
        replayed: true,
        species,
      };
    }

    const candidateStatus = state.candidateRelease?.status ?? null;

    if (candidateStatus === null || candidateStatus === "DRAFT") {
      const [{ importGen123 }, { applyGen123World }, { validateGen123Final }] = await Promise.all([
        import("../../db/imports/gen123/import.js"),
        import("../../db/imports/gen123/world.js"),
        import("../../db/imports/gen123/final-validate.js"),
      ]);

      await importGen123();
      await applyGen123World();

      // Source geography is verified as import provenance only. It is never activated.
      const sourceReport = await validateGen123Final(false);
      assertGen123SourceReport(sourceReport);

      // Bell's playable world is exclusively Zhoulia.
      await reconcileZhouliaExclusiveRelease(pool, {
        releaseId: STAGING_GEN123_RELEASE_ID,
        starterOptions: canonicalStarterOptions,
      });
    } else {
      // A crash after final validation/publication is resumable only if the candidate
      // already satisfies the Zhoulia-only contract. Old validated Kanto candidates fail closed.
      await assertZhouliaExclusiveRelease(pool, { releaseId: STAGING_GEN123_RELEASE_ID });
    }

    await publishCandidate(pool);
    await assertZhouliaExclusiveRelease(pool, { releaseId: STAGING_GEN123_RELEASE_ID });

    const beforeActivation = await currentState(pool);
    if (beforeActivation.activeRelease?.id === STAGING_GEN123_RELEASE_ID) {
      throw new Error("candidate became ACTIVE before explicit activation");
    }

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const activated = await catalog.activateRelease(STAGING_GEN123_RELEASE_ID);
    if (!activated.ok) {
      throw new Error(
        `Zhoulia activation failed [${activated.error.code}]: ${activated.error.message}`,
      );
    }

    const finalState = await currentState(pool);
    if (planStagingContentBootstrap(finalState) !== "VERIFY_ACTIVE_CANDIDATE") {
      throw new Error(
        `unexpected staging catalog state after activation: ${JSON.stringify(finalState)}`,
      );
    }

    await assertZhouliaExclusiveRelease(pool, { releaseId: STAGING_GEN123_RELEASE_ID });
    const species = await activeSpeciesCount(pool);
    if (species !== 386) {
      throw new Error(`ACTIVE Zhoulia catalog expected 386 species, got ${species}`);
    }

    console.log(
      JSON.stringify({
        event: "staging.content.bootstrap.complete",
        revision,
        releaseId: STAGING_GEN123_RELEASE_ID,
        replayed: false,
        species,
        world: "zhoulia",
      }),
    );
    return {
      releaseId: STAGING_GEN123_RELEASE_ID,
      replayed: false,
      species,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("staging-content-bootstrap.ts")) {
  await bootstrapStagingContent();
}
