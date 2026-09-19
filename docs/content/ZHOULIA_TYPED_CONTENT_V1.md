# Zhoulia Typed Content V1

This tranche establishes the first typed Zhoulia vertical without hard-wired UUIDs:

- Vila dos Arrozais
- Campos de Yun
- bidirectional route Vila dos Arrozais ↔ Campos de Yun
- explicit DAY/NIGHT/WATER/RARE encounter conditions
- stable semantic identities for areas, sites, NPC roles, pools and routes
- canonical Nurse Hana
- unnamed Xamã role
- unnamed Grass Gym leader role
- O Poço preserved as a secret underground arena
- distinct first-arrival and return narrative keys for Vila dos Arrozais
- deterministic SHA-256 content fingerprint
- semantic content diff
- importer plan that accepts DRAFT releases only
- WEATHER reserved as an explicit future condition kind, with no simulator invented

The next tranche wires this typed bundle into the PostgreSQL content-release importer and publish lifecycle while preserving older releases.
