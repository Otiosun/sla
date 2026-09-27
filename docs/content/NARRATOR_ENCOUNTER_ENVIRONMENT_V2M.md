# Narrator Encounter Environment V2M

The first Zhoulia vertical now has environment-aware encounter tables and a runtime encounter service that accepts semantic environment context. This tranche wires the narrator/admin land-spawn boundary to that context without inventing world clock hours.

Runtime configuration:

- `BELL_WORLD_TIME_OF_DAY=DAY|NIGHT` remains an optional explicit override.
- when no override is configured, narrator/admin random land spawns derive the semantic period from the runtime machine's local clock: `06:00–17:59 => DAY`, otherwise `NIGHT`.
- `BELL_WORLD_WEATHER_KEY` is optional and reserved for explicit environmental content.
- narrator/admin normal exploration uses `surface=LAND` and `rarity=COMMON`.
- an explicitly forced species bypasses natural species membership/weight for that table, while the local eligible table still supplies the encounter level band.

Fishing remains a separate flow and is not reclassified as narrator LAND exploration.
