# Gen I-III content source provenance

## Pinned source

- Provider: `PokeAPI/pokeapi`
- Commit: `7af36d9f3424366ffc46e90d94c8bc120df39cd0`
- Imported subtree: `data/v2/csv`
- Import scope: National Dex 1-386 plus the Kanto, Johto and Hoenn catalog/world records explicitly selected by the Phase 15 importer.
- Importer entrypoint: `db/imports/gen123/import.ts`
- Validator: `db/imports/gen123/validate.ts`
- Permanent PostgreSQL proof: `db/proofs/phase15_gen123_import_e2e.ts`

The importer consumes a local checkout of the exact commit above. Runtime gameplay does not depend on the public PokéAPI service, and a later change to upstream data cannot silently change an already validated candidate release.

## License and attribution

The pinned PokéAPI repository carries the BSD 3-Clause license and the copyright notice for Paul Hallett and PokéAPI contributors. Its license file also states that Pokémon and Pokémon character names are trademarks of Nintendo.

The BSD grant applies to the PokéAPI project under its license terms. It must not be interpreted as a license or transfer of Nintendo / Pokémon intellectual-property rights, character rights or trademarks. The project must retain the PokéAPI copyright/license notice where redistribution obligations apply and must not imply endorsement by PokéAPI or its contributors.

Canonical upstream license at the pinned commit:

`PokeAPI/pokeapi/LICENSE.md@7af36d9f3424366ffc46e90d94c8bc120df39cd0`

## Reproducibility rules

1. Never replace the pinned commit with a branch name such as `master` or `main` in a production proof.
2. Never query the live PokéAPI HTTP service as part of deterministic release generation.
3. Never hand-edit individual Pokémon to make a validator pass. Fix the importer, source mapping or an explicit project-owned override dataset.
4. A new upstream snapshot requires a new provenance decision and a new candidate release; it must not mutate a validated/published snapshot.
5. Source omissions stay explicit. The importer must preserve `NULL`, disabled, partial or blocked support instead of inventing mechanical values.
6. The Phase 15 candidate remains non-active until its validation and the separate canonical world-connection decision are complete.

## Known Phase 15 boundaries

- The project ruleset v1 uses its existing modern/hybrid mechanical contract. `Gen I-III` defines the content scope; it does not mean emulating historical Generation III battle rules. This is why retroactive official typings such as Clefairy -> Fairy remain valid in the v1 catalog.
- Moves whose pinned source row has no PP are retained as catalog data with `max_pp = NULL`, but are excluded from executable START/LEVEL learnsets. No PP value is fabricated.
- Ability identities/data are imported, while unimplemented mechanical effects remain explicitly unsupported rather than being simulated by guessed behavior.
- Complex evolution data is preserved but rules requiring unsupported owner mechanics remain disabled.
- PokéAPI locations do not provide the canonical client-approved area-connection graph required by this project. Area connections therefore remain blocked instead of being fabricated.
- Encounter data is currently normalized into the Phase 15 v1 aggregate table representation. Method/version-specific encounter segmentation is not claimed as preserved by this release.
- Publication/activation remains a separate blocked step after validation; the importer never swaps the ACTIVE release pointer by itself.
