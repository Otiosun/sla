# Seeds

Seeds populate deliberate, reviewable content **after** the database schema is migrated. They are not schema migrations and must never be used to hide missing DDL.

## Phase 4 vertical slice

Run:

```bash
pnpm db:migrate
pnpm db:seed:phase4
```

`phase4_vertical_slice.ts` creates a small Kanto/Route 1 catalog, validates it through the same `CatalogService` used by the application, publishes the ruleset and content release, and moves the `ACTIVE` pointer to that published release.

Properties required of seeds:

- application-generated UUIDs;
- fail closed when canonical identities/config conflict;
- lifecycle-aware (`DRAFT -> VALIDATED -> PUBLISHED`), never direct publish;
- no executable content stored in catalog configuration;
- safe to re-run only when the existing canonical seed agrees with the expected identity/config;
- independent from migration files.

Seeds are for controlled bootstrap/test/demo content. Bulk official Pokémon data belongs to `db/imports/` and must pass the same validation/publish pipeline before becoming active.
