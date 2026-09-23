# Zhoulia Release Lifecycle V2L

Disposable PostgreSQL proof for the first Zhoulia vertical.

The test is fully self-contained with repository data. It migrates an empty disposable database and executes the repository's Phase 4 vertical-slice seed directly through Node + tsx, so it does not depend on `POKEAPI_DATA_DIR` or an external CSV checkout.

It then clones the current ACTIVE/PUBLISHED release into a new DRAFT. Species that are referenced by the authored Zhoulia encounter pools but are not present in the compact Phase 4 seed receive minimal **test-only** catalog revisions inside that disposable DRAFT. Those fixtures reuse an already valid active type, ability, and move solely so the canonical catalog validator can exercise the lifecycle. They are not production Zhoulia species definitions and are not an authored-data source.

The proof then imports Vila dos Arrozais + Campos de Yun, materializes seven encounter tables, validates and fingerprints the candidate, publishes it without moving ACTIVE, explicitly activates it, confirms the previous release remains PUBLISHED, rolls back to that release, and reactivates the Zhoulia candidate.

Publication and activation remain separate operations. No existing release is overwritten or archived.
