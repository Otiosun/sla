import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("DATABASE_URL is required for the Phase 11 progression seed");

const RULESET_KEY = "phase4-core-v1";
const BASE_RULESET_VERSION = 1;
const RULESET_VERSION = 2;
const RELEASE_NO = 5n;
const RELEASE_NAME = "Phase 11 Progression Slice v1";

const PROGRESSION_CONFIG = {
  pokemon: {
    xpCurve: "CUBIC_DELTA_V1",
    battleRewardModel: "BASE_EXP_LEVEL_DIV_7_V1",
    rewardRecipient: "ACTIVE_WINNER_V1",
    levelCap: 100,
    hpOnLevelUp: "ADD_MAX_HP_DELTA_IF_ALIVE_V1",
    fullMoveSlotsPolicy: "PENDING_CHOICE_V1",
    autoLevelEvolution: true,
  },
  trainer: {
    visiblePointsName: "XP de Treinador",
    levelCurve: "QUADRATIC_100_V1",
    levelCap: 100,
    pointsPerWonBattle: 100,
    unlocks: [
      { level: 10, unlockKey: "tournament.tier-1" },
      { level: 15, unlockKey: "tournament.tier-2" },
    ],
  },
} as const;

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
  if (baseRow === undefined)
    throw new Error("Phase 11 requires the published Phase 4 base ruleset");
  const parsedBase = RulesetConfigSchema.safeParse(baseRow.config);
  if (!parsedBase.success) throw new Error("Base ruleset config is invalid");
  const expectedConfig = { ...parsedBase.data, progression: PROGRESSION_CONFIG };

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
  if (row === undefined) throw new Error("Failed to resolve Phase 11 ruleset");
  if (!isDeepStrictEqual(row.config, expectedConfig)) {
    throw new Error("Existing Phase 11 ruleset differs from canonical progression config");
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
  }>(`SELECT id, status, name, default_ruleset_id FROM content_releases WHERE release_no = $1`, [
    RELEASE_NO.toString(),
  ]);
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    if (existingRow.name !== RELEASE_NAME || existingRow.default_ruleset_id !== rulesetId) {
      throw new Error("Release 5 is already bound to unexpected progression content");
    }
    return { id: existingRow.id, status: existingRow.status };
  }

  const active = await pool.query<{ content_release_id: string }>(
    `SELECT content_release_id FROM content_release_pointers WHERE pointer_key = 'ACTIVE'`,
  );
  const parentReleaseId = active.rows[0]?.content_release_id;
  if (parentReleaseId === undefined) throw new Error("Phase 11 requires an active parent release");
  const newReleaseId = randomUUID();
  unwrap(
    "clone Phase 11 release",
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
  if (changed.rowCount !== 1)
    throw new Error("Failed to bind Phase 11 release to progression ruleset");
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
      unwrap("validate Phase 11 ruleset", await catalog.validateRuleset(ruleset.id));
      unwrap("publish Phase 11 ruleset", await catalog.publishRuleset(ruleset.id));
    } else if (ruleset.status === "VALIDATED") {
      unwrap("publish Phase 11 ruleset", await catalog.publishRuleset(ruleset.id));
    } else if (ruleset.status !== "PUBLISHED") {
      throw new Error(`Phase 11 ruleset is not usable from status ${ruleset.status}`);
    }

    const release = await ensureRelease(pool, catalog, ruleset.id);
    if (release.status === "DRAFT") {
      unwrap("validate Phase 11 release", await catalog.validateRelease(release.id));
      unwrap("publish Phase 11 release", await catalog.publishRelease(release.id));
    } else if (release.status === "VALIDATED") {
      unwrap("publish Phase 11 release", await catalog.publishRelease(release.id));
    } else if (release.status !== "PUBLISHED") {
      throw new Error(`Phase 11 release is not usable from status ${release.status}`);
    }
    unwrap("activate Phase 11 release", await catalog.activateRelease(release.id));
    console.log(`Phase 11 progression slice ready: release ${release.id}, ruleset ${ruleset.id}`);
  } finally {
    await pool.end();
  }
}

await main();
