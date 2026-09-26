# Zhoulia Runtime Environment V2H

This tranche connects the already-materialized Zhoulia environmental encounter conditions to the runtime encounter-selection boundary.

`CreateEncounterInput` now carries an optional internal `environment` context:

- `timeOfDay`: DAY or NIGHT
- `surface`: LAND or WATER
- `rarity`: COMMON or RARE
- `weatherKey`: reserved for future environmental policy

The service passes this context to both encounter-table and encounter-entry eligibility checks.

No numeric hour boundary is invented here. The authored content distinguishes DAY/NIGHT, but the project has not defined canonical clock ranges yet. Therefore the runtime accepts semantic environment context and remains fail-closed when a required environmental dimension is absent.

This tranche intentionally preserves `spawnQuantity` and the narrator multi-wild flow already present in `CreateEncounterInput`.
