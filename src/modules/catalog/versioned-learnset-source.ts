import { z } from "zod";

/**
 * Import boundary only: Never fetch external APIs during gameplay, never mutate a
 * published release here. Operators review and pin these source records before
 * producing a new immutable content release.
 */
const MoveEntrySchema = z.object({
  move: z.object({ name: z.string().min(1) }),
  version_group_details: z.array(z.object({
    level_learned_at: z.number().int().min(0),
    move_learn_method: z.object({ name: z.string().min(1) }),
    version_group: z.object({ name: z.string().min(1) }),
  })),
});

const PokemonLearnsetSourceSchema = z.object({
  name: z.string().min(1),
  moves: z.array(MoveEntrySchema),
});

export type VersionedAcquisitionMethod = "LEVEL" | "EVOLUTION" | "MACHINE" | "TUTOR" | "EGG";
export interface VersionedAcquisitionMove {
  readonly moveSlug: string;
  readonly method: VersionedAcquisitionMethod;
  /** Null for EVOLUTION/MACHINE/TUTOR/EGG; evolution uses source level 0. */
  readonly learnLevel: number | null;
}

export interface VersionedAcquisitionLearnset {
  readonly pokemonSlug: string;
  readonly versionGroup: string;
  readonly moves: readonly VersionedAcquisitionMove[];
}

/**
 * One pinned game generation; method 0 level-up is an evolution move, not invalid.
 * TM item -> move pairing is resolved separately by the version-specific
 * PokéAPI machine resource, never guessed from the move name.
 */
export function parseVersionedAcquisitionLearnset(
  raw: unknown,
  versionGroup = "scarlet-violet",
): VersionedAcquisitionLearnset {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(versionGroup)) throw new RangeError("Invalid version group");
  const source = PokemonLearnsetSourceSchema.parse(raw);
  const moves = new Map<string, VersionedAcquisitionMove>();
  let versionPresent = false;
  for (const entry of source.moves) {
    for (const record of entry.version_group_details) {
      if (record.version_group.name !== versionGroup) continue;
      versionPresent = true;
      const kind = record.move_learn_method.name;
      const method: VersionedAcquisitionMethod | null =
        kind === "level-up" ? record.level_learned_at === 0 ? "EVOLUTION" : "LEVEL"
        : kind === "machine" ? "MACHINE"
        : kind === "tutor" ? "TUTOR"
        : kind === "egg" ? "EGG" : null;
      if (method === null) continue;
      if (method === "LEVEL" && (record.level_learned_at < 1 || record.level_learned_at > 100)) {
        throw new RangeError("Learn level outside Pokémon level cap");
      }
      const learnedAt = method === "LEVEL" ? record.level_learned_at : null;
      const normalized = { moveSlug: entry.move.name, method, learnLevel: learnedAt };
      // A Pokémon may legitimately learn the same move at multiple levels.
      // The unique source identity is move + method + level, not just move.
      const key = `${entry.move.name}:${method}:${learnedAt ?? ""}`;
      moves.set(key, normalized);
    }
  }
  if (!versionPresent || moves.size === 0) {
    throw new Error(`No acquisition records for ${source.name} in ${versionGroup}`);
  }
  return {
    pokemonSlug: source.name,
    versionGroup,
    moves: [...moves.values()].sort((a, b) => a.method.localeCompare(b.method) ||
      (a.learnLevel ?? 0) - (b.learnLevel ?? 0) || a.moveSlug.localeCompare(b.moveSlug)),
  };
}

export interface VersionedLevelMove {
  readonly moveSlug: string;
  readonly learnLevel: number;
}

export interface VersionedLearnset {
  readonly pokemonSlug: string;
  readonly versionGroup: string;
  readonly moves: readonly VersionedLevelMove[];
}

/**
 * Reads only moves learned by LEVEL-UP in one explicit game version group.
 * Discards machine, tutor, egg, and other methods: those require separate
 * gameplay services and must NOT be granted by a level award.
 * No guessing or blending versions when a form has no records.
 */
export function parseVersionedLevelLearnset(
  raw: unknown,
  versionGroup = "scarlet-violet",
): VersionedLearnset {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(versionGroup)) {
    throw new RangeError("Invalid version group");
  }
  const parsed = PokemonLearnsetSourceSchema.parse(raw);
  const byMoveAndLevel = new Map<string, VersionedLevelMove>();
  let hasVersionData = false;
  for (const entry of parsed.moves) {
    for (const version of entry.version_group_details) {
      if (version.version_group.name !== versionGroup) continue;
      hasVersionData = true;
      if (version.move_learn_method.name !== "level-up") continue;
      if (version.level_learned_at === 0) continue; // EVOLUTION, processed separately
      if (version.level_learned_at < 1 || version.level_learned_at > 100) {
        throw new RangeError("Level-up learnset entry outside levels 1–100");
      }
      byMoveAndLevel.set(`${entry.move.name}:${version.level_learned_at}`, {
        moveSlug: entry.move.name, learnLevel: version.level_learned_at,
      });
    }
  }
  if (!hasVersionData || byMoveAndLevel.size === 0) {
    throw new Error(`No level-up source data for ${parsed.name} in ${versionGroup}; do not infer`);
  }
  return {
    pokemonSlug: parsed.name,
    versionGroup,
    moves: [...byMoveAndLevel.values()]
      .sort((a, b) => a.learnLevel - b.learnLevel || a.moveSlug.localeCompare(b.moveSlug)),
  };
}

export interface LearnsetDiscrepancy {
  readonly moveSlug: string;
  readonly sourceLevel: number | null;
  readonly catalogLevel: number | null;
}

/** Audits a proposed seed's LEVEL move list against a version-pinned source. */
export function compareLevelLearnsets(
  source: VersionedLearnset,
  catalog: readonly VersionedLevelMove[],
): readonly LearnsetDiscrepancy[] {
  const expected = new Map<string, Set<number>>();
  const actual = new Map<string, Set<number>>();
  for (const entry of source.moves) {
    const levels = expected.get(entry.moveSlug) ?? new Set<number>();
    levels.add(entry.learnLevel);
    expected.set(entry.moveSlug, levels);
  }
  for (const entry of catalog) {
    const levels = actual.get(entry.moveSlug) ?? new Set<number>();
    levels.add(entry.learnLevel);
    actual.set(entry.moveSlug, levels);
  }
  const allMoves = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return allMoves.flatMap((moveSlug) => {
    const sourceLevels = [...(expected.get(moveSlug) ?? [])].sort((a,b)=>a-b);
    const catalogLevels = [...(actual.get(moveSlug) ?? [])].sort((a,b)=>a-b);
    if (sourceLevels.length === 1 && catalogLevels.length === 1 &&
        sourceLevels[0] !== catalogLevels[0]) {
      return [{ moveSlug, sourceLevel: sourceLevels[0] ?? null, catalogLevel: catalogLevels[0] ?? null }];
    }
    return [
      ...sourceLevels.filter((level)=>!catalogLevels.includes(level))
        .map((sourceLevel)=>({moveSlug,sourceLevel,catalogLevel:null})),
      ...catalogLevels.filter((level)=>!sourceLevels.includes(level))
        .map((catalogLevel)=>({moveSlug,sourceLevel:null,catalogLevel})),
    ];
  });
}
