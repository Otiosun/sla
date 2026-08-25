# Imports

Importers are the boundary for large external/content datasets such as the later Gen I–III catalog. They are intentionally separate from both schema migrations and hand-written bootstrap seeds.

A future importer must:

1. parse untrusted source data into typed application contracts;
2. resolve or create stable catalog identities with application-generated UUIDs;
3. write only into a `DRAFT` ruleset/content release;
4. never execute JavaScript, SQL, templates, or arbitrary expressions from imported data;
5. validate references, ranges, encounter tables, evolution rules and effect primitives through the canonical catalog validator;
6. produce a readable diff/fingerprint before publish;
7. publish only through the catalog lifecycle service;
8. preserve previous published releases so historical encounters/battles remain interpretable.

The full Gen I–III importer is outside Phase 4. Phase 4 proves the boundary with the small vertical-slice seed in `db/seeds/phase4_vertical_slice.ts`.
