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
  const byMove = new Map<string, number>();
  let hasVersionData = false;
  for (const entry of parsed.moves) {
    for (const version of entry.version_group_details) {
      if (version.version_group.name !== versionGroup) continue;
      hasVersionData = true;
      if (version.move_learn_method.name !== "level-up") continue;
      if (version.level_learned_at < 1 || version.level_learned_at > 100) {
        throw new RangeError("Level-up learnset entry outside levels 1–100");
      }
      const previous = byMove.get(entry.move.name);
      if (previous !== undefined && previous !== version.level_learned_at) {
        throw new Error(`Conflicting learn level for ${entry.move.name} in ${versionGroup}`);
      }
      byMove.set(entry.move.name, version.level_learned_at);
    }
  }
  if (!hasVersionData || byMove.size === 0) {
    throw new Error(`No level-up source data for ${parsed.name} in ${versionGroup}; do not infer`);
  }
  return {
    pokemonSlug: parsed.name,
    versionGroup,
    moves: [...byMove].map(([moveSlug, learnLevel]) => ({ moveSlug, learnLevel }))
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
  const expected = new Map(source.moves.map((move) => [move.moveSlug, move.learnLevel]));
  const actual = new Map(catalog.map((move) => [move.moveSlug, move.learnLevel]));
  const allMoves = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return allMoves.flatMap((moveSlug) => {
    const sourceLevel = expected.get(moveSlug) ?? null;
    const catalogLevel = actual.get(moveSlug) ?? null;
    return sourceLevel === catalogLevel ? [] : [{ moveSlug, sourceLevel, catalogLevel }];
  });
}
