# Narrator Encounter Environment V2M

The first Zhoulia vertical now has environment-aware encounter tables and a runtime encounter service that accepts semantic environment context. This tranche wires the narrator/admin land-spawn boundary to that context without inventing world clock hours.

Runtime configuration:

- `BELL_WORLD_TIME_OF_DAY=DAY|NIGHT` is mandatory for narrator/admin land spawns that use environment-gated encounter tables.
- `BELL_WORLD_WEATHER_KEY` is optional and reserved for explicit environmental content.
- narrator/admin normal exploration uses `surface=LAND` and `rarity=COMMON`.

There is intentionally no conversion such as `06:00 => DAY` or `18:00 => NIGHT`. The authored Zhoulia descriptions distinguish day and night but do not define numeric hour boundaries. Until a canonical clock policy is supplied, the runtime period is an explicit semantic operational setting and fails closed if it is missing.

Fishing remains a separate flow and is not reclassified as narrator LAND exploration.
