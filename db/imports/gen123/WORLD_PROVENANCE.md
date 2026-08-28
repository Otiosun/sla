# Phase 15 — Gen I–III world topology provenance

This importer does not infer a world graph from names alone and does not call external APIs at runtime.

Pinned sources:

- Catalog identities/data: `PokeAPI/pokeapi@7af36d9f3424366ffc46e90d94c8bc120df39cd0`
- Kanto topology primary: `pret/pokefirered@c75f352304d529f6ba92d4f74b9cf8b5c3810788`
- Johto topology, plus Kanto links absent from the FireRed/LeafGreen primary graph: `pret/pokecrystal@7a7881d0d62e0ddbd82dcf10e7116807487ac651`
- Hoenn topology: `pret/pokeemerald@c65e93f20a5275ab03b07d6f6411096a82a60ffd`

## Mapping policy

Physical travel nodes are derived from pinned game map metadata. GBA maps use `region_map_section`, map-border connections and cross-map warps. Crystal uses its map landmark metadata, border connections, exact map constants and cross-map warps. Multiple internal maps or floors with the same canonical regional identity collapse to one PokeAPI location.

Aliases are explicit in `world-source.ts`; ambiguous matches fail closed instead of guessing. Kanto uses FireRed/LeafGreen as primary topology. Crystal contributes Johto and cross-region/Kanto links only when the corresponding Kanto topology is not already represented by the FireRed/LeafGreen primary graph.

Some PokeAPI locations used by Gen I–III encounter rows are aggregate encounter buckets rather than distinct physical travel nodes, for example roaming or generic Pokécenter buckets. They remain active so encounter data is not discarded, but they do not receive fabricated travel edges. The final validation report records these as `encounterOnlyAreas`.

Story/progression gates are intentionally not reconstructed from ROM scripts in this slice. Imported graph edges therefore use the canonical open access-rule shape only. This imports topology, not invented campaign progression.

## Release lifecycle

The final Phase 15 proof imports the catalog, applies the topology, performs final catalog validation and canonical fingerprinting, then publishes the ruleset and content release through `CatalogService`.

Publication must leave the `ACTIVE` content pointer unchanged. `PUBLISHED` means the candidate is a complete immutable release artifact; activation/deployment is a separate operation and is not performed by this importer or proof.
