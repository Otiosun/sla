import { createHash } from "node:crypto";
import type { RulesetSnapshot } from "./contracts.js";
import type { CatalogSnapshotWithEffects } from "./validation.js";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) output[key] = canonicalize(nested);
  }
  return output;
}

function sortByCanonical<T>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => {
    const leftText = JSON.stringify(canonicalize(left));
    const rightText = JSON.stringify(canonicalize(right));
    return leftText.localeCompare(rightText);
  });
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function fingerprintRuleset(snapshot: RulesetSnapshot): string {
  return sha256Canonical({
    config: snapshot.config,
    typeMatchups: sortByCanonical(snapshot.typeMatchups),
  });
}

export function fingerprintCatalog(snapshot: CatalogSnapshotWithEffects): string {
  return sha256Canonical({
    defaultRulesetId: snapshot.release.defaultRulesetId,
    rulesetFingerprint: fingerprintRuleset(snapshot.ruleset),
    types: sortByCanonical(snapshot.types),
    species: sortByCanonical(snapshot.species),
    forms: sortByCanonical(snapshot.forms),
    moves: sortByCanonical(snapshot.moves),
    abilities: sortByCanonical(snapshot.abilities),
    items: sortByCanonical(snapshot.items),
    natures: sortByCanonical(snapshot.natures),
    effects: sortByCanonical(snapshot.effects),
    regions: sortByCanonical(snapshot.regions),
    areas: sortByCanonical(snapshot.areas),
    connections: sortByCanonical(snapshot.connections),
    formAbilities: sortByCanonical(snapshot.formAbilities),
    learnsets: sortByCanonical(snapshot.learnsets),
    evolutions: sortByCanonical(snapshot.evolutions),
    encounterTables: sortByCanonical(
      snapshot.encounterTables.map((table) => ({
        ...table,
        entries: sortByCanonical(table.entries),
      })),
    ),
  });
}
