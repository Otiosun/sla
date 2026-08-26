import { sha256Canonical } from "./fingerprint.js";
import type { CatalogSnapshotWithEffects } from "./validation.js";

export interface ReleaseDiffSection {
  readonly category: string;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

export interface ReleaseDiff {
  readonly fromReleaseId: string;
  readonly toReleaseId: string;
  readonly sections: readonly ReleaseDiffSection[];
}

interface DiffRecord {
  readonly key: string;
  readonly value: unknown;
}

function compareRecords(
  category: string,
  from: readonly DiffRecord[],
  to: readonly DiffRecord[],
): ReleaseDiffSection {
  const fromMap = new Map(from.map((entry) => [entry.key, sha256Canonical(entry.value)]));
  const toMap = new Map(to.map((entry) => [entry.key, sha256Canonical(entry.value)]));
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const [key, hash] of toMap) {
    const previous = fromMap.get(key);
    if (previous === undefined) added += 1;
    else if (previous !== hash) changed += 1;
  }
  for (const key of fromMap.keys()) {
    if (!toMap.has(key)) removed += 1;
  }

  return { category, added, removed, changed };
}

function snapshotRecords(
  snapshot: CatalogSnapshotWithEffects,
): Readonly<Record<string, readonly DiffRecord[]>> {
  return {
    types: snapshot.types.map((entry) => ({ key: entry.typeId, value: entry })),
    species: snapshot.species.map((entry) => ({ key: entry.speciesId, value: entry })),
    forms: snapshot.forms.map((entry) => ({ key: entry.formId, value: entry })),
    moves: snapshot.moves.map((entry) => ({ key: entry.moveId, value: entry })),
    abilities: snapshot.abilities.map((entry) => ({ key: entry.abilityId, value: entry })),
    items: snapshot.items.map((entry) => ({ key: entry.itemId, value: entry })),
    natures: snapshot.natures.map((entry) => ({ key: entry.natureId, value: entry })),
    effects: snapshot.effects.map((entry) => ({ key: entry.effectId, value: entry })),
    regions: snapshot.regions.map((entry) => ({ key: entry.regionId, value: entry })),
    areas: snapshot.areas.map((entry) => ({ key: entry.areaId, value: entry })),
    connections: snapshot.connections.map((entry) => ({ key: entry.connectionId, value: entry })),
    formAbilities: snapshot.formAbilities.map((entry) => ({
      key: `${entry.formId}:${entry.abilityId}`,
      value: entry,
    })),
    learnsets: snapshot.learnsets.map((entry) => ({
      key: `${entry.formId}:${entry.moveId}:${entry.learnMethod}:${entry.learnLevel ?? "-"}`,
      value: entry,
    })),
    evolutions: snapshot.evolutions.map((entry) => ({
      key: `${entry.fromFormId}:${entry.toFormId}:${entry.triggerKind}`,
      value: entry,
    })),
    starterOptions: snapshot.starterOptions.map((entry) => ({
      key: `${entry.regionId}:${entry.formId}`,
      value: entry,
    })),
    purchaseOffers: snapshot.purchaseOffers.map((entry) => ({
      key: entry.offerKey,
      value: entry,
    })),
    encounterTables: snapshot.encounterTables.map((entry) => ({
      key: entry.encounterTableId,
      value: entry,
    })),
  };
}

export function diffCatalogSnapshots(
  from: CatalogSnapshotWithEffects,
  to: CatalogSnapshotWithEffects,
): ReleaseDiff {
  const fromRecords = snapshotRecords(from);
  const toRecords = snapshotRecords(to);
  const categories = Object.keys(fromRecords).sort();
  return {
    fromReleaseId: from.release.id,
    toReleaseId: to.release.id,
    sections: categories.map((category) =>
      compareRecords(category, fromRecords[category] ?? [], toRecords[category] ?? []),
    ),
  };
}

export function formatReleaseDiff(diff: ReleaseDiff): string {
  const lines = [`release ${diff.fromReleaseId} -> ${diff.toReleaseId}`];
  for (const section of diff.sections) {
    if (section.added === 0 && section.removed === 0 && section.changed === 0) continue;
    lines.push(`${section.category}: +${section.added} -${section.removed} ~${section.changed}`);
  }
  if (lines.length === 1) lines.push("no content changes");
  return lines.join("\n");
}
