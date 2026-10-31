import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { auditStage2ContentReadiness } from "../../src/modules/catalog/stage2-content-readiness.js";
import type { CatalogSnapshot } from "../../src/modules/catalog/contracts.js";

/** Reads only a disposable PG copy. Never updates live content or grants items. */
type Problem = { code: string; entityId: string; detail: string };
type Source = {
  format: string;
  pokemon: {
    pokemonSlug: string;
    versionGroup: string;
    moves: { moveSlug: string; method: string; learnLevel: number | null }[];
  }[];
  machines: { itemSlug: string; moveSlug: string; versionGroup: string }[];
  moveDefinitions: { slug: string; basicDamageCandidate: boolean; reviewReasons: string[] }[];
  evolutionChains: {
    chainId: number;
    rootSpeciesSlug: string;
    edges: {
      fromSpeciesSlug: string;
      toSpeciesSlug: string;
      method: "LEVEL" | "ITEM" | "CONDITION_REVIEW";
      requiredLevel: number | null;
      itemSlug: string | null;
      nontrivialRequirements: readonly string[];
    }[];
  }[];
};
const strict = process.argv.includes("--strict");
const idx = process.argv.indexOf("--proposal");
const input = idx === -1 ? null : process.argv[idx + 1];
const outIndex = process.argv.indexOf("--output");
const outPath = outIndex === -1 ? null : process.argv[outIndex + 1];
if (idx >= 0 && (!input || input.startsWith("--"))) throw Error("Expected --proposal file path");
if (outIndex >= 0 && (!outPath || outPath.startsWith("--"))) throw Error("Expected --output path");
const url = new URL(process.env.DATABASE_URL ?? "");
if (
  process.env.APP_ENV !== "test" ||
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" ||
  !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
  url.pathname !== "/pokemon_rpg_test"
) {
  throw Error("Only authorized disposable PostgreSQL is supported");
}
const manifest = JSON.parse(
  await readFile("docs/catalog/pokemon-beyond-move-sources.json", "utf8"),
) as {
  versionGroup: string;
  pokemonSlugs: string[];
  explicitlyApprovedVersionOverrides?: Record<string, string>;
};
const source = input ? (JSON.parse(await readFile(input, "utf8")) as Source) : null;
if (source && source.format !== "POKEMON_BEYOND_MOVE_PROPOSAL_V1")
  throw Error("Invalid source proposal format");
if (strict && !source)
  throw Error("Strict publication gating requires the external versioned proposal");
const issues: Problem[] = [];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const active = await pool.query<{ id: string; status: string }>(
    "SELECT r.id::text,r.status FROM content_release_pointers p JOIN content_releases r ON r.id=p.content_release_id WHERE p.pointer_key='ACTIVE'",
  );
  const release = active.rows[0];
  if (!release || release.status !== "PUBLISHED")
    throw Error("ACTIVE published content release not found");
  const id = release.id;
  const results = await Promise.all([
    pool.query<{
      formId: string;
      speciesId: string;
      type1Id: string;
      type2Id: string | null;
      slug: string;
      active: boolean;
    }>(
      'SELECT f.form_id::text AS "formId",p.species_id::text AS "speciesId",f.type1_id::text AS "type1Id",f.type2_id::text AS "type2Id",s.slug,f.active FROM pokemon_form_revisions f JOIN pokemon_forms p ON p.id=f.form_id JOIN pokemon_species s ON s.id=p.species_id WHERE f.content_release_id=$1',
      [id],
    ),
    pool.query<{
      moveId: string;
      typeId: string;
      category: "PHYSICAL" | "SPECIAL" | "STATUS";
      power: number | null;
      accuracy: number | null;
      priority: number;
      maxPp: number | null;
      effectKey: string | null;
      effectConfig: unknown;
      slug: string;
      active: boolean;
    }>(
      'SELECT r.move_id::text AS "moveId",r.type_id::text AS "typeId",r.category,r.power,r.accuracy,r.priority,r.max_pp AS "maxPp",r.effect_key AS "effectKey",r.effect_config AS "effectConfig",m.slug,r.active FROM move_revisions r JOIN moves m ON m.id=r.move_id WHERE r.content_release_id=$1',
      [id],
    ),
    pool.query<{
      itemId: string;
      itemKind: string;
      effectKey: string | null;
      effectConfig: unknown;
      slug: string;
      active: boolean;
    }>(
      'SELECT r.item_id::text AS "itemId",r.item_kind AS "itemKind",r.effect_key AS "effectKey",r.effect_config AS "effectConfig",i.slug,r.active FROM item_revisions r JOIN items i ON i.id=r.item_id WHERE r.content_release_id=$1',
      [id],
    ),
    pool.query<{
      formId: string;
      moveId: string;
      learnMethod: string;
      learnLevel: number | null;
      active: boolean;
    }>(
      'SELECT form_id::text AS "formId",move_id::text AS "moveId",learn_method AS "learnMethod",learn_level AS "learnLevel",active FROM move_learnset_entries WHERE content_release_id=$1',
      [id],
    ),
    pool.query<{
      fromFormId: string;
      toFormId: string;
      triggerKind: "LEVEL" | "ITEM" | "CONDITION";
      triggerConfig: unknown;
      active: boolean;
    }>(
      'SELECT from_form_id::text AS "fromFormId",to_form_id::text AS "toFormId",trigger_kind AS "triggerKind",trigger_config AS "triggerConfig",active FROM evolution_rules WHERE content_release_id=$1',
      [id],
    ),
    pool.query<{
      offerKey: string;
      itemId: string;
      currencyId: string;
      itemQuantity: string;
      priceAmount: string;
      sortOrder: number;
      active: boolean;
    }>(
      'SELECT offer_key AS "offerKey",item_id::text AS "itemId",currency_id::text AS "currencyId",item_quantity::text AS "itemQuantity",price_amount::text AS "priceAmount",sort_order AS "sortOrder",active FROM item_purchase_offers WHERE content_release_id=$1',
      [id],
    ),
  ]);
  const forms = results[0].rows,
    moves = results[1].rows,
    items = results[2].rows;
  const learnsets = results[3].rows,
    evolutions = results[4].rows,
    offers = results[5].rows;
  const allowed = new Set(manifest.pokemonSlugs);
  const seen = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const form of forms.filter((f) => f.active)) {
    if (seen.has(form.slug))
      issues.push({
        code: "UNPINNED_FORM_VARIANT",
        entityId: form.slug,
        detail: "Multiple active form variants must each have an explicit source",
      });
    seen.set(form.slug, form.formId);
    if (!allowed.has(form.slug))
      issues.push({
        code: "ACTIVE_FORM_NOT_IN_MANIFEST",
        entityId: form.slug,
        detail: "No version group defined for this active form",
      });
    else
      versions.set(
        form.formId,
        manifest.explicitlyApprovedVersionOverrides?.[form.slug] ?? manifest.versionGroup,
      );
  }
  for (const slug of allowed)
    if (!seen.has(slug)) {
      issues.push({
        code: "MANIFEST_FORM_ABSENT",
        entityId: slug,
        detail: "Approved form is missing from PUBLISHED release",
      });
    }
  const snapshot: Pick<
    CatalogSnapshot,
    "forms" | "moves" | "items" | "learnsets" | "evolutions" | "purchaseOffers"
  > = {
    forms: forms.map(({ slug: _slug, ...x }) => x),
    moves: moves.map(({ slug: _slug, ...x }) => x),
    items: items.map(({ slug: _slug, ...x }) => x),
    learnsets,
    evolutions,
    purchaseOffers: offers,
  };
  issues.push(
    ...auditStage2ContentReadiness(snapshot, {
      learnsetVersionGroupByForm: versions,
      extraPlayerObtainableItemIds: new Set(),
      advertisedOfferKeys: [],
    }),
  );
  if (source) {
    const sourceSlugs = new Set(source.pokemon.map((p) => p.pokemonSlug));
    const activeMoves = new Map(moves.filter((m) => m.active).map((m) => [m.moveId, m.slug]));
    const activeMoveSlugs = new Set(activeMoves.values());
    const activeItemSlugs = new Set(items.filter((i) => i.active).map((i) => i.slug));
    for (const slug of allowed)
      if (!sourceSlugs.has(slug)) {
        issues.push({
          code: "MISSING_SOURCE_PROPOSAL",
          entityId: slug,
          detail: "No external source data",
        });
      }
    for (const pokemon of source.pokemon) {
      const formId = seen.get(pokemon.pokemonSlug);
      if (!formId) continue;
      if (versions.get(formId) !== pokemon.versionGroup) {
        issues.push({
          code: "SOURCE_VERSION_DRIFT",
          entityId: pokemon.pokemonSlug,
          detail: "Source version differs from approved manifest",
        });
        continue;
      }
      const known = new Set(
        learnsets
          .filter((m) => m.active && m.formId === formId)
          .map((m) => [activeMoves.get(m.moveId), m.learnMethod, m.learnLevel ?? ""].join(":")),
      );
      for (const move of pokemon.moves) {
        if (!activeMoveSlugs.has(move.moveSlug)) {
          issues.push({
            code: "UNPUBLISHED_MOVE",
            entityId: pokemon.pokemonSlug,
            detail: move.moveSlug + " (" + move.method + ")",
          });
          continue;
        }
        if (["LEVEL", "EVOLUTION", "MACHINE"].includes(move.method)) {
          const method = move.method === "MACHINE" ? "TM" : move.method;
          const signature = [move.moveSlug, method, move.learnLevel ?? ""].join(":");
          const alternate = [move.moveSlug, move.method, move.learnLevel ?? ""].join(":");
          if (!known.has(signature) && !known.has(alternate)) {
            issues.push({
              code: "MISSING_LEARN_METHOD",
              entityId: pokemon.pokemonSlug,
              detail: move.moveSlug + " " + move.method + " level=" + (move.learnLevel ?? "none"),
            });
          }
        }
      }
    }
    for (const machine of source.machines) {
      if (!activeItemSlugs.has(machine.itemSlug))
        issues.push({
          code: "MISSING_TM_ITEM",
          entityId: machine.itemSlug,
          detail:
            "Machine for " +
            machine.moveSlug +
            " (" +
            machine.versionGroup +
            ") has no published item",
        });
    }
    for (const chain of source.evolutionChains) {
      for (const edge of chain.edges) {
        const from = seen.get(edge.fromSpeciesSlug);
        if (!from) continue; // No published source form, so no player can evolve it.
        const to = seen.get(edge.toSpeciesSlug);
        if (!to) {
          issues.push({
            code: "EVOLUTION_TARGET_NOT_PUBLISHED",
            entityId: edge.fromSpeciesSlug,
            detail: edge.toSpeciesSlug + " (" + edge.method + ") has no active destination form",
          });
          continue;
        }
        if (edge.method === "CONDITION_REVIEW") {
          issues.push({
            code: "EVOLUTION_CONDITION_UNIMPLEMENTED",
            entityId: edge.fromSpeciesSlug,
            detail:
              edge.toSpeciesSlug +
              " needs explicit domain requirements: " +
              edge.nontrivialRequirements.join(","),
          });
          continue;
        }
        const matching = evolutions.some((rule) => {
          if (
            !rule.active ||
            rule.fromFormId !== from ||
            rule.toFormId !== to ||
            rule.triggerKind !== edge.method
          )
            return false;
          const config = rule.triggerConfig;
          if (typeof config !== "object" || config === null) return false;
          const data = config as Record<string, unknown>;
          if (edge.method === "LEVEL") return data.level === edge.requiredLevel;
          const item = items.find((i) => i.itemId === data.itemId && i.active);
          return item?.slug === edge.itemSlug;
        });
        if (!matching)
          issues.push({
            code: "EVOLUTION_RULE_NOT_PUBLISHED",
            entityId: edge.fromSpeciesSlug,
            detail: edge.toSpeciesSlug + " lacks a verified " + edge.method + " rule",
          });
      }
    }
  }
  const codes = [...new Set(issues.map((i) => i.code))].sort();
  const counts = Object.fromEntries(
    codes.map((code) => [code, issues.filter((i) => i.code === code).length]),
  );
  const report = {
    format: "POKEMON_BEYOND_STAGE2_RELEASE_AUDIT_V1",
    releaseId: id,
    manifestForms: allowed.size,
    activeForms: forms.filter((f) => f.active).length,
    activeMoves: moves.filter((m) => m.active).length,
    activeItems: items.filter((i) => i.active).length,
    sourceCompared: source !== null,
    pass: source !== null && issues.length === 0,
    sourceMoveDefinitions: source?.moveDefinitions.length ?? 0,
    sourceEffectsNeedingReview:
      source?.moveDefinitions.filter((m) => !m.basicDamageCandidate).length ?? 0,
    sourceEvolutionChains: source?.evolutionChains.length ?? 0,
    sourceEvolutionEdges: source?.evolutionChains.reduce((n, c) => n + c.edges.length, 0) ?? 0,
    issuesCount: issues.length,
    counts,
    issues,
  };
  console.log(
    JSON.stringify({
      event: "stage2.release.audit",
      releaseId: id,
      activeForms: report.activeForms,
      activeMoves: report.activeMoves,
      sourceCompared: report.sourceCompared,
      issuesCount: report.issuesCount,
      counts,
    }),
  );
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  if (strict && !report.pass) process.exitCode = 1;
} finally {
  await pool.end();
}
