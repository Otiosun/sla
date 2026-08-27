import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 11 trainer final seed");
}

const RULESET_KEY = "phase4-core-v1";
const BASE_RULESET_VERSION = 2;
const RULESET_VERSION = 3;
const PARENT_RELEASE_NO = 5n;
const RELEASE_NO = 6n;
const RELEASE_NAME = "Phase 11 Trainer Progression Final v1";

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function ensureRuleset(client: PoolClient): Promise<{ id: string; status: string }> {
  const base = await client.query<{ id: string; config: unknown }>(
    `SELECT id, config FROM rulesets WHERE key = $1 AND version = $2`,
    [RULESET_KEY, BASE_RULESET_VERSION],
  );
  const baseRow = base.rows[0];
  if (baseRow === undefined) {
    throw new Error(
      "Final trainer progression requires the published Phase 11 provisional ruleset",
    );
  }
  const parsedBase = RulesetConfigSchema.safeParse(baseRow.config);
  if (!parsedBase.success || parsedBase.data.progression === undefined) {
    throw new Error("Phase 11 provisional progression config is invalid");
  }
  const baseProgression = parsedBase.data.progression;
  const expectedConfig = {
    ...parsedBase.data,
    progression: {
      ...baseProgression,
      trainer: {
        ...baseProgression.trainer,
        visiblePointsName: "Insígnia",
        levelCurve: "LINEAR_100_V1",
        unlocks: [{ level: 10, unlockKey: "tournament.eligible" }],
      },
    },
  } as const;
  RulesetConfigSchema.parse(expectedConfig);

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, $3, 1, $4::jsonb, 'DRAFT')
     ON CONFLICT (key, version) DO NOTHING`,
    [randomUUID(), RULESET_KEY, RULESET_VERSION, JSON.stringify(expectedConfig)],
  );
  const result = await client.query<{ id: string; status: string; config: unknown }>(
    `SELECT id, status, config FROM rulesets WHERE key = $1 AND version = $2`,
    [RULESET_KEY, RULESET_VERSION],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Failed to resolve final trainer progression ruleset");
  if (!isDeepStrictEqual(row.config, expectedConfig)) {
    throw new Error("Existing final trainer ruleset differs from canonical Insígnia config");
  }
  if (row.status === "DRAFT") {
    await client.query(
      `INSERT INTO type_matchups(ruleset_id, attacking_type_id, defending_type_id, multiplier_basis_points)
       SELECT $1, attacking_type_id, defending_type_id, multiplier_basis_points
       FROM type_matchups WHERE ruleset_id = $2
       ON CONFLICT DO NOTHING`,
      [row.id, baseRow.id],
    );
  }
  return { id: row.id, status: row.status };
}

async function ensureRelease(
  pool: Pool,
  catalog: CatalogService,
  rulesetId: string,
): Promise<{ id: string; status: string }> {
  const existing = await pool.query<{
    id: string;
    status: string;
    name: string;
    default_ruleset_id: string;
  }>(
    `SELECT id, status, name, default_ruleset_id
     FROM content_releases WHERE release_no = $1`,
    [RELEASE_NO.toString()],
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    if (existingRow.name !== RELEASE_NAME || existingRow.default_ruleset_id !== rulesetId) {
      throw new Error("Release 6 is already bound to unexpected trainer progression content");
    }
    return { id: existingRow.id, status: existingRow.status };
  }

  const parentRelease = await pool.query<{ id: string }>(
    `SELECT id FROM content_releases
     WHERE release_no = $1 AND status = 'PUBLISHED'`,
    [PARENT_RELEASE_NO.toString()],
  );
  const parentReleaseId = parentRelease.rows[0]?.id;
  if (parentReleaseId === undefined) {
    throw new Error("Final trainer progression requires published Phase 11 release 5");
  }
  const newReleaseId = randomUUID();
  unwrap(
    "clone final trainer progression release",
    await catalog.clonePublishedRelease({
      parentReleaseId,
      newReleaseId,
      releaseNo: RELEASE_NO,
      name: RELEASE_NAME,
    }),
  );
  const changed = await pool.query(
    `UPDATE content_releases
     SET default_ruleset_id = $2
     WHERE id = $1 AND status = 'DRAFT'`,
    [newReleaseId, rulesetId],
  );
  if (changed.rowCount !== 1) {
    throw new Error("Failed to bind release 6 to final trainer progression ruleset");
  }
  return { id: newReleaseId, status: "DRAFT" };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const migrations = await loadMigrations();
    const verifyClient = await pool.connect();
    try {
      await verifyAppliedMigrations(verifyClient, migrations, true);
    } finally {
      verifyClient.release();
    }

    const ruleset = await (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await ensureRuleset(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })();

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    if (ruleset.status === "DRAFT") {
      unwrap("validate final trainer ruleset", await catalog.validateRuleset(ruleset.id));
      unwrap("publish final trainer ruleset", await catalog.publishRuleset(ruleset.id));
    } else if (ruleset.status === "VALIDATED") {
      unwrap("publish final trainer ruleset", await catalog.publishRuleset(ruleset.id));
    } else if (ruleset.status !== "PUBLISHED") {
      throw new Error(`Final trainer ruleset is not usable from status ${ruleset.status}`);
    }

    const release = await ensureRelease(pool, catalog, ruleset.id);
    if (release.status === "DRAFT") {
      unwrap("validate final trainer release", await catalog.validateRelease(release.id));
      unwrap("publish final trainer release", await catalog.publishRelease(release.id));
    } else if (release.status === "VALIDATED") {
      unwrap("publish final trainer release", await catalog.publishRelease(release.id));
    } else if (release.status !== "PUBLISHED") {
      throw new Error(`Final trainer release is not usable from status ${release.status}`);
    }
    unwrap("activate final trainer release", await catalog.activateRelease(release.id));
    console.log(`Final trainer progression ready: release ${release.id}, ruleset ${ruleset.id}`);
  } finally {
    await pool.end();
  }
}

await main();
