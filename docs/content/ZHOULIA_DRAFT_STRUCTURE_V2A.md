# Zhoulia DRAFT Structure V2A

This tranche wires the typed Zhoulia first vertical into PostgreSQL **without publishing it**.

It persists only data that is already editorially specified:

- Vila dos Arrozais and Campos de Yun as release-scoped area revisions
- Vila ↔ Yun as two directed area connections
- runtime-safe world config for starting area, safe point and facilities
- narrative/presentation metadata (sites, NPC roles, editorial notes, first/return arrival keys)
- explicit encounter condition contract for DAY/NIGHT, LAND/WATER, rarity and future weather

Encounter species pools remain typed and validated, but **weights and level ranges are intentionally not invented**. The importer reports those pools as `PENDING_LEVELS_AND_WEIGHTS`, so a release cannot be treated as encounter-ready just because its geography was imported.

No ACTIVE content pointer is modified by this importer. It accepts DRAFT releases only and is idempotent for the same release.
