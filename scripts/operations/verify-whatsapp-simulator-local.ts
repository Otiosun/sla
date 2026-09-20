import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { GEN123_SOURCE } from "../../db/imports/gen123/source.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";
import { assertZhouliaExclusiveRelease } from "../../src/platform/world/postgres-zhoulia-exclusive-release.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function command(commandName: string, args: readonly string[], cwd = root): string {
  return execFileSync(commandName, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function databaseName(raw: string): string {
  const url = new URL(raw);
  const value = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!value) throw new Error("SIMULATOR_DATABASE_NAME_MISSING");
  return value;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly engines?: { readonly node?: string; readonly pnpm?: string };
};

const expectedNode = packageJson.engines?.node;
const expectedPnpm = packageJson.engines?.pnpm;
if (!expectedNode || !expectedPnpm) throw new Error("TOOLCHAIN_PIN_MISSING");
if (process.version.replace(/^v/u, "") !== expectedNode) {
  throw new Error(`NODE_VERSION_MISMATCH expected=${expectedNode} actual=${process.version}`);
}
const pnpmVersion = command(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--version"]);
if (pnpmVersion !== expectedPnpm) {
  throw new Error(`PNPM_VERSION_MISMATCH expected=${expectedPnpm} actual=${pnpmVersion}`);
}

const status = command("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
const unexpected = status
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((line) => !/^\?\? \.sim-pokeapi(?:\/|$)/u.test(line));
if (unexpected.length > 0) {
  throw new Error(`WORKTREE_NOT_CLEAN ${JSON.stringify(unexpected)}`);
}
const revision = command("git", ["rev-parse", "HEAD"]);

const pokeapiDataDir = requiredEnv("POKEAPI_DATA_DIR");
const pokeapiRevision = command("git", ["-C", pokeapiDataDir, "rev-parse", "HEAD"]);
if (pokeapiRevision !== GEN123_SOURCE.commit) {
  throw new Error(
    `POKEAPI_PIN_MISMATCH expected=${GEN123_SOURCE.commit} actual=${pokeapiRevision}`,
  );
}

const simulatorRaw = requiredEnv("SIMULATOR_DATABASE_URL");
const sourceRaw = process.env.DATABASE_URL?.trim();
if (sourceRaw && sourceRaw === simulatorRaw) {
  throw new Error("SIMULATOR_DATABASE_URL_MUST_DIFFER_FROM_DATABASE_URL");
}
const simulatorName = databaseName(simulatorRaw);
if (!/simulator/iu.test(simulatorName)) {
  throw new Error(`SIMULATOR_DATABASE_NAME_NOT_EXPLICITLY_DISPOSABLE ${simulatorName}`);
}

const expectedStarters = [
  "bulbasaur",
  "charmander",
  "squirtle",
  "chikorita",
  "cyndaquil",
  "totodile",
  "treecko",
  "torchic",
  "mudkip",
] as const;

const expectedAbilityEffects = new Map<string, string>([
  ["levitate", "type-immunity"],
  ["thick-fat", "incoming-type-damage-multiplier"],
  ["huge-power", "battle-stat-multiplier"],
  ["pure-power", "battle-stat-multiplier"],
  ["guts", "battle-stat-multiplier"],
  ["marvel-scale", "battle-stat-multiplier"],
]);

const expectedTyrogue = new Map<string, string>([
  ["hitmonlee", "ATTACK_GT_DEFENSE"],
  ["hitmonchan", "ATTACK_LT_DEFENSE"],
  ["hitmontop", "ATTACK_EQ_DEFENSE"],
]);

const pool = new Pool({
  connectionString: simulatorRaw,
  max: 4,
  connectionTimeoutMillis: 5_000,
});

try {
  await assertDatabaseSchemaCurrent(pool);

  const active = await pool.query<{
    release_id: string;
    release_name: string;
    release_status: string;
    ruleset_key: string;
    ruleset_status: string;
  }>(
    `SELECT release.id AS release_id,
            release.name AS release_name,
            release.status AS release_status,
            ruleset.key AS ruleset_key,
            ruleset.status AS ruleset_status
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id=pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
      WHERE pointer.pointer_key='ACTIVE'`,
  );
  const activeRow = active.rows[0];
  if (!activeRow) throw new Error("ACTIVE_RELEASE_MISSING");
  if (activeRow.release_name !== "Simulator - Zhoulia + Gen I-III Mechanics") {
    throw new Error(`ACTIVE_RELEASE_UNEXPECTED ${activeRow.release_name}`);
  }
  if (activeRow.release_status !== "PUBLISHED" || activeRow.ruleset_status !== "PUBLISHED") {
    throw new Error(
      `ACTIVE_RELEASE_NOT_PUBLISHED release=${activeRow.release_status} ruleset=${activeRow.ruleset_status}`,
    );
  }
  if (activeRow.ruleset_key !== "gen123-core") {
    throw new Error(`RULESET_MISMATCH ${activeRow.ruleset_key}`);
  }

  const exclusive = await assertZhouliaExclusiveRelease(pool, {
    releaseId: activeRow.release_id,
  });
  if (exclusive.activeStarterCount !== expectedStarters.length) {
    throw new Error(
      `STARTER_COUNT_MISMATCH expected=${expectedStarters.length} actual=${exclusive.activeStarterCount}`,
    );
  }

  const starters = await pool.query<{ slug: string }>(
    `SELECT species.slug
       FROM starter_options option
       JOIN pokemon_forms form ON form.id=option.form_id
       JOIN pokemon_species species ON species.id=form.species_id
      WHERE option.content_release_id=$1 AND option.active=TRUE
      ORDER BY option.sort_order,species.slug`,
    [activeRow.release_id],
  );
  const starterSlugs = starters.rows.map((row) => row.slug);
  if (JSON.stringify(starterSlugs) !== JSON.stringify(expectedStarters)) {
    throw new Error(
      `STARTER_SET_MISMATCH expected=${JSON.stringify(expectedStarters)} actual=${JSON.stringify(starterSlugs)}`,
    );
  }

  const fidelity = await pool.query<{
    total_species: number;
    sourced_species: number;
    generic_learnsets: number;
    type_matchups: number;
    sourced_catalog_species: number;
  }>(
    `WITH encounter_species AS (
       SELECT DISTINCT species.id
         FROM encounter_entries entry
         JOIN encounter_table_revisions table_revision
           ON table_revision.id=entry.encounter_table_revision_id
         JOIN pokemon_forms form ON form.id=entry.form_id
         JOIN pokemon_species species ON species.id=form.species_id
        WHERE table_revision.content_release_id=$1
          AND table_revision.active=TRUE
          AND entry.active=TRUE
     )
     SELECT
       (SELECT count(*)::int FROM encounter_species) AS total_species,
       (
         SELECT count(*)::int
           FROM encounter_species selected
           JOIN pokemon_species_revisions revision
             ON revision.species_id=selected.id
            AND revision.content_release_id=$1
            AND revision.active=TRUE
          WHERE revision.data->>'sourceProvider'=$2
            AND revision.data->>'sourceCommit'=$3
       ) AS sourced_species,
       (
         SELECT count(*)::int
           FROM move_learnset_entries
          WHERE content_release_id=$1
            AND active=TRUE
            AND source_key='phase7-test-only-zhoulia-fixture'
       ) AS generic_learnsets,
       (
         SELECT count(*)::int
           FROM type_matchups matchup
           JOIN content_releases release ON release.default_ruleset_id=matchup.ruleset_id
          WHERE release.id=$1
       ) AS type_matchups,
       (
         SELECT count(*)::int
           FROM pokemon_species_revisions revision
          WHERE revision.content_release_id=$1
            AND revision.active=TRUE
            AND revision.data->>'sourceProvider'=$2
            AND revision.data->>'sourceCommit'=$3
       ) AS sourced_catalog_species`,
    [activeRow.release_id, GEN123_SOURCE.provider, GEN123_SOURCE.commit],
  );
  const fidelityRow = fidelity.rows[0];
  if (!fidelityRow) throw new Error("FIDELITY_AUDIT_EMPTY");
  if (
    fidelityRow.total_species < 1 ||
    fidelityRow.sourced_species !== fidelityRow.total_species ||
    fidelityRow.generic_learnsets !== 0 ||
    fidelityRow.type_matchups !== 324 ||
    fidelityRow.sourced_catalog_species !== 386
  ) {
    throw new Error(`FIDELITY_MISMATCH ${JSON.stringify(fidelityRow)}`);
  }

  const abilities = await pool.query<{
    slug: string;
    effect_key: string | null;
  }>(
    `SELECT ability.slug,revision.effect_key
       FROM ability_revisions revision
       JOIN abilities ability ON ability.id=revision.ability_id
      WHERE revision.content_release_id=$1
        AND revision.active=TRUE
        AND ability.slug=ANY($2::text[])
      ORDER BY ability.slug`,
    [activeRow.release_id, [...expectedAbilityEffects.keys()]],
  );
  for (const [slug, effectKey] of expectedAbilityEffects) {
    const row = abilities.rows.find((candidate) => candidate.slug === slug);
    if (row?.effect_key !== effectKey) {
      throw new Error(
        `ABILITY_EFFECT_MISMATCH slug=${slug} expected=${effectKey} actual=${row?.effect_key ?? "missing"}`,
      );
    }
  }

  const evolutions = await pool.query<{
    target_slug: string;
    trigger_kind: string;
    trigger_config: unknown;
  }>(
    `SELECT target_species.slug AS target_slug,rule.trigger_kind,rule.trigger_config
       FROM evolution_rules rule
       JOIN pokemon_forms source_form ON source_form.id=rule.from_form_id
       JOIN pokemon_species source_species ON source_species.id=source_form.species_id
       JOIN pokemon_forms target_form ON target_form.id=rule.to_form_id
       JOIN pokemon_species target_species ON target_species.id=target_form.species_id
      WHERE rule.content_release_id=$1
        AND rule.active=TRUE
        AND source_species.slug='tyrogue'
        AND target_species.slug=ANY($2::text[])
      ORDER BY target_species.slug`,
    [activeRow.release_id, [...expectedTyrogue.keys()]],
  );
  for (const [targetSlug, relativePhysicalStats] of expectedTyrogue) {
    const row = evolutions.rows.find((candidate) => candidate.target_slug === targetSlug);
    const config = asRecord(row?.trigger_config);
    if (
      row?.trigger_kind !== "LEVEL" ||
      config.level !== 20 ||
      config.relativePhysicalStats !== relativePhysicalStats
    ) {
      throw new Error(
        `TYROGUE_EVOLUTION_MISMATCH target=${targetSlug} actual=${JSON.stringify(row ?? null)}`,
      );
    }
  }

  const transport = await pool.query<{
    auth_rows: number;
    groups: number;
    players: number;
    admins: number;
  }>(
    `SELECT
       ((SELECT count(*) FROM whatsapp_auth_sessions) +
        (SELECT count(*) FROM whatsapp_auth_keys))::int AS auth_rows,
       (SELECT count(*) FROM community_groups
         WHERE provider='baileys' AND status='ACTIVE')::int AS groups,
       (SELECT count(*) FROM player_identities
         WHERE provider='baileys' AND status='ACTIVE')::int AS players,
       (SELECT count(*) FROM admin_principals
         WHERE status='ACTIVE' AND identity_ref LIKE 'whatsapp:%')::int AS admins`,
  );
  const transportRow = transport.rows[0];
  if (!transportRow) throw new Error("SIMULATOR_FIXTURE_AUDIT_EMPTY");
  if (transportRow.auth_rows !== 0) throw new Error("SIMULATOR_REAL_AUTH_MATERIAL_PRESENT");
  if (transportRow.groups < 2 || transportRow.players < 3 || transportRow.admins < 2) {
    throw new Error(`SIMULATOR_FIXTURE_INCOMPLETE ${JSON.stringify(transportRow)}`);
  }

  console.log(
    JSON.stringify({
      event: "local.simulator.verified",
      revision,
      database: simulatorName,
      pokeapiRevision,
      releaseId: activeRow.release_id,
      starters: starterSlugs,
      activeAreas: exclusive.activeAreaSlugs,
      activeConnections: exclusive.activeConnectionKeys,
      fidelity: fidelityRow,
      fixture: transportRow,
    }),
  );
} finally {
  await pool.end();
}
