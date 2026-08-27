import { Pool } from "pg";
import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";
import {
  trainerLevelForPoints,
  trainerPointsRequiredForLevel,
} from "../../src/modules/progression/rules.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 11 trainer final proof");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  const active = await pool.query<{
    release_no: string;
    ruleset_version: number;
    config: unknown;
  }>(
    `SELECT release.release_no::text, ruleset.version AS ruleset_version, ruleset.config
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
     WHERE pointer.pointer_key = 'ACTIVE' AND release.status = 'PUBLISHED'`,
  );
  const row = active.rows[0];
  if (row === undefined || row.release_no !== "6" || row.ruleset_version !== 3) {
    throw new Error(`Final trainer release/ruleset is not active: ${JSON.stringify(row)}`);
  }
  const config = RulesetConfigSchema.parse(row.config);
  const trainer = config.progression?.trainer;
  if (
    trainer === undefined ||
    trainer.visiblePointsName !== "Insígnia" ||
    trainer.levelCurve !== "LINEAR_100_V1" ||
    trainer.unlocks.length !== 1 ||
    trainer.unlocks[0]?.level !== 10 ||
    trainer.unlocks[0]?.unlockKey !== "tournament.eligible"
  ) {
    throw new Error(`Final trainer config is not canonical: ${JSON.stringify(trainer)}`);
  }
  if (
    trainerPointsRequiredForLevel(1, trainer.levelCurve) !== 0 ||
    trainerPointsRequiredForLevel(2, trainer.levelCurve) !== 100 ||
    trainerPointsRequiredForLevel(10, trainer.levelCurve) !== 900 ||
    trainerPointsRequiredForLevel(100, trainer.levelCurve) !== 9_900 ||
    trainerLevelForPoints(899, trainer.levelCap, trainer.levelCurve) !== 9 ||
    trainerLevelForPoints(900, trainer.levelCap, trainer.levelCurve) !== 10 ||
    trainerLevelForPoints(999, trainer.levelCap, trainer.levelCurve) !== 10 ||
    trainerLevelForPoints(1_000, trainer.levelCap, trainer.levelCurve) !== 11
  ) {
    throw new Error("LINEAR_100_V1 does not grant exactly one trainer level per 100 Insígnias");
  }

  const historical = await pool.query<{ config: unknown }>(
    `SELECT config FROM rulesets WHERE key = 'phase4-core-v1' AND version = 2`,
  );
  const historicalConfig = RulesetConfigSchema.parse(historical.rows[0]?.config);
  if (
    historicalConfig.progression?.trainer.levelCurve !== "QUADRATIC_100_V1" ||
    historicalConfig.progression.trainer.visiblePointsName !== "XP de Treinador" ||
    trainerPointsRequiredForLevel(10, "QUADRATIC_100_V1") !== 8_100
  ) {
    throw new Error("Historical trainer progression was not preserved");
  }

  console.log(
    "Phase 11 final trainer proof complete: Insígnia, LINEAR_100_V1, level-10 tournament eligibility and historical ruleset preservation verified",
  );
} finally {
  await pool.end();
}
