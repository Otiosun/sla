import { Pool } from "pg";
import { CatalogService } from "../../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../../src/platform/catalog/postgres-catalog-repository.js";
import { gen123Id } from "./ids.js";
import { validateGen123Final } from "./final-validate.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required for Gen I-III publication");

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

export async function publishGen123(): Promise<{
  readonly releaseId: string;
  readonly releaseStatus: string;
  readonly rulesetStatus: string;
  readonly activeReleaseId: string | null;
}> {
  const report = await validateGen123Final(false);
  if (!report.ok || report.coverage.blocked.length !== 0)
    throw new Error("Gen I-III release cannot publish with incomplete final validation");

  const releaseId = gen123Id("release:gen123-production-candidate-v1");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    const repository = new PostgresCatalogRepository(pool);
    const catalog = new CatalogService(repository);
    const before = await pool.query<{
      release_status: string;
      ruleset_id: string;
      ruleset_status: string;
      active_release_id: string | null;
    }>(
      `SELECT release.status release_status,
              release.default_ruleset_id ruleset_id,
              ruleset.status ruleset_status,
              (SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE') active_release_id
         FROM content_releases release
         JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
        WHERE release.id=$1`,
      [releaseId],
    );
    const current = before.rows[0];
    if (current === undefined) throw new Error("Gen I-III release disappeared before publication");
    if (current.active_release_id === releaseId)
      throw new Error("Gen I-III candidate must not be ACTIVE during publication proof");

    if (current.ruleset_status === "VALIDATED")
      unwrap("publish Gen I-III ruleset", await catalog.publishRuleset(current.ruleset_id));
    else if (current.ruleset_status !== "PUBLISHED")
      throw new Error(`Unexpected ruleset status before publication: ${current.ruleset_status}`);

    if (current.release_status === "VALIDATED")
      unwrap("publish Gen I-III release", await catalog.publishRelease(releaseId));
    else if (current.release_status !== "PUBLISHED")
      throw new Error(`Unexpected release status before publication: ${current.release_status}`);

    const after = await pool.query<{
      release_status: string;
      ruleset_status: string;
      active_release_id: string | null;
    }>(
      `SELECT release.status release_status,
              ruleset.status ruleset_status,
              (SELECT content_release_id FROM content_release_pointers WHERE pointer_key='ACTIVE') active_release_id
         FROM content_releases release
         JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
        WHERE release.id=$1`,
      [releaseId],
    );
    const published = after.rows[0];
    if (published?.release_status !== "PUBLISHED" || published.ruleset_status !== "PUBLISHED")
      throw new Error("Gen I-III ruleset/release did not reach PUBLISHED");
    if (published.active_release_id !== current.active_release_id)
      throw new Error("Publication unexpectedly changed the ACTIVE content pointer");

    return {
      releaseId,
      releaseStatus: published.release_status,
      rulesetStatus: published.ruleset_status,
      activeReleaseId: published.active_release_id,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("publish.ts"))
  console.log(JSON.stringify(await publishGen123(), null, 2));
