import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  auditOverdueLevelEvolution,
  type LevelEvolutionCandidate,
} from "../../src/modules/progression/recovery-audit.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";
import { parsePlayerId, parsePokemonInstanceId } from "../../src/shared-kernel/ids.js";

/**
 * Stage2 legacy evolution reconciliation, SAFE MODE:
 * - Only accepts a disposable loopback PostgreSQL database.
 * - --apply ALSO requires a one-time environment acknowledgement.
 * - No live DB, no production players, no migrations, no changes to grants.
 * - Reuses the canonical idempotent evolution transaction, not direct UPDATEs.
 */
const urlString = process.env.DATABASE_URL ?? "";
const permission = process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1";
let localUrl: URL;
try {
  localUrl = new URL(urlString);
} catch {
  throw new Error("A valid disposable DATABASE_URL is required");
}
if (
  !permission ||
  process.env.APP_ENV !== "test" ||
  localUrl.pathname !== "/pokemon_rpg_test" ||
  !["localhost", "127.0.0.1", "::1"].includes(localUrl.hostname) ||
  !["postgres:", "postgresql:"].includes(localUrl.protocol)
) {
  throw new Error("Only explicitly enabled loopback disposable PostgreSQL may be audited");
}
const apply = process.argv.includes("--apply");
if (apply && process.env.STAGE2_RECONCILE_DISPOSABLE_APPLY !== "CONFIRMED_TEST_ONLY") {
  throw new Error(
    "Applying compensation requires STAGE2_RECONCILE_DISPOSABLE_APPLY=CONFIRMED_TEST_ONLY",
  );
}

interface SourceRow {
  readonly pokemon_id: string;
  readonly player_id: string;
  readonly release_id: string;
  readonly form_id: string;
  readonly level: number;
  readonly target_form_id: string;
  readonly trigger_config: unknown;
}

function parseLevelRule(config: unknown): {
  level: number;
  relativePhysicalStats: LevelEvolutionCandidate["relativePhysicalStats"];
} | null {
  if (typeof config !== "object" || config === null) return null;
  const data = config as Record<string, unknown>;
  const level = data.level ?? data.minimumLevel;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 2 || level > 100)
    return null;
  const relative = data.relativePhysicalStats;
  if (
    relative !== undefined &&
    relative !== "ATTACK_GT_DEFENSE" &&
    relative !== "ATTACK_LT_DEFENSE" &&
    relative !== "ATTACK_EQ_DEFENSE"
  )
    return null;
  return {
    level,
    relativePhysicalStats: relative === undefined ? null : relative,
  };
}

const pool = new Pool({ connectionString: urlString, max: 3 });
try {
  const result = await pool.query<SourceRow>(
    `SELECT pokemon.id::text AS pokemon_id,
            pokemon.owner_player_id::text AS player_id,
            context.content_release_id::text AS release_id,
            pokemon.form_id::text AS form_id,
            pokemon.level,
            rule.to_form_id::text AS target_form_id,
            rule.trigger_config
       FROM pokemon_instances pokemon
       JOIN player_onboarding_context context
         ON context.player_id = pokemon.owner_player_id
       JOIN evolution_rules rule
         ON rule.content_release_id = context.content_release_id
        AND rule.from_form_id = pokemon.form_id
        AND rule.trigger_kind = 'LEVEL'
        AND rule.active = TRUE
       WHERE pokemon.status = 'ACTIVE'
       ORDER BY pokemon.id, rule.id`,
  );
  const grouped = new Map<string, SourceRow[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.pokemon_id) ?? [];
    list.push(row);
    grouped.set(row.pokemon_id, list);
  }
  const summary = {
    mode: apply ? "DISPOSABLE_APPLY" : "DRY_RUN",
    candidatesReviewed: 0,
    eligibleForReview: 0,
    needsStatsReview: 0,
    ambiguous: 0,
    corrected: 0,
    errors: 0,
  };
  const progression = new ProgressionService(new PostgresProgressionRepository(pool));
  for (const group of grouped.values()) {
    const current = group[0];
    if (!current) continue;
    const candidates: LevelEvolutionCandidate[] = [];
    let invalidRules = false;
    for (const row of group) {
      const config = parseLevelRule(row.trigger_config);
      if (config === null) {
        invalidRules = true;
        continue;
      }
      candidates.push({
        targetFormId: row.target_form_id,
        requiredLevel: config.level,
        relativePhysicalStats: config.relativePhysicalStats,
      });
    }
    summary.candidatesReviewed += 1;
    if (invalidRules) {
      summary.errors += 1;
      continue;
    }
    const finding = auditOverdueLevelEvolution({ currentLevel: current.level, candidates });
    if (finding.state === "AMBIGUOUS") {
      summary.ambiguous += 1;
      continue;
    }
    if (finding.state === "NEEDS_STAT_REVIEW") {
      summary.needsStatsReview += 1;
      continue;
    }
    if (finding.state !== "ELIGIBLE_TO_REVIEW") continue;
    summary.eligibleForReview += 1;
    if (!apply) continue;

    const parsedPlayerId = parsePlayerId(current.player_id);
    const parsedPokemonId = parsePokemonInstanceId(current.pokemon_id);
    if (!parsedPlayerId.ok || !parsedPokemonId.ok) {
      summary.errors += 1;
      continue;
    }
    const evolved = await progression.evolvePokemon({
      playerId: parsedPlayerId.value,
      pokemonInstanceId: parsedPokemonId.value,
      trigger: { kind: "LEVEL" },
      idempotencyKey: `stage2.reconcile-level:${current.player_id}:${current.pokemon_id}:${current.release_id}:${current.form_id}`,
      correlationId: randomUUID(),
    });
    if (evolved.ok && evolved.value.toFormId === finding.candidateTargetFormId) {
      summary.corrected += 1;
    } else {
      summary.errors += 1;
    }
  }
  console.log(JSON.stringify({ event: "stage2.overdue-evolution", ...summary }));
  if (summary.errors > 0 || summary.ambiguous > 0) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
