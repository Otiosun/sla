export interface PokedexSpeciesEntry {
  readonly seenCount: bigint;
  readonly caughtCount: bigint;
}

export function isValidPokedexEntry(entry: PokedexSpeciesEntry): boolean {
  return entry.seenCount >= 0n && entry.caughtCount >= 0n && entry.caughtCount <= entry.seenCount;
}
