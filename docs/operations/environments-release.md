# Environment and release contract

## Purpose

Phase 17 separates development, test, staging and production as operational environments rather than aliases for the same database or credentials. The application already validates `APP_ENV` as one of `development`, `test`, `staging` or `production`; this document defines the deployment contract around that code-level boundary.

The contract is fail-closed. Missing production/staging role separation, an unknown environment, an unpinned deployment revision or a failed migration blocks promotion.

## Environment matrix

| Environment | Durable PostgreSQL | WhatsApp/provider identity | Migration credential | Deployment policy |
| --- | --- | --- | --- | --- |
| `development` | local/disposable | fake/local unless explicitly testing provider integration | may reuse runtime credential | developer-controlled; never treated as release evidence |
| `test` | disposable CI/test database | fake/contract adapter; no production session | may reuse runtime credential | automated tests only |
| `staging` | dedicated PostgreSQL, isolated from production | dedicated staging auth/session when provider integration is enabled | mandatory and distinct from runtime | release candidate only; same code path and PostgreSQL major version as production where possible |
| `production` | dedicated production PostgreSQL | production auth/session only | mandatory and distinct from runtime | approved immutable revision only; no manual code edits as the normal deployment process |

### Isolation invariants

- Staging and production must never share a database, runtime login, migrator login, WhatsApp authentication/session state or backup prefix.
- Staging and production use the same application code paths and migration set for a given candidate SHA.
- PostgreSQL compatibility target is the repository-pinned PostgreSQL 18.6 baseline unless a separately approved infrastructure decision changes it.
- Environment secrets stay in the deployment secret/environment layer. They do not belong in Git, Drive, PR bodies, workflow logs or chat transcripts.
- Runtime and migrator PostgreSQL usernames must be different in staging/production; `loadConfig()` rejects missing or shared roles.
- Production startup must continue to fail when the database schema is not current.

## Controlled migration step

Numbered migrations are applied only by the migrator role and remain governed by the existing checksum/advisory-lock/transaction contract in `src/platform/db/migrations.ts`.

For staging or production release candidates use:

```bash
APP_ENV=staging \
DATABASE_URL="$STAGING_RUNTIME_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$STAGING_MIGRATOR_DATABASE_URL" \
DEPLOY_REVISION="<full-40-char-git-sha>" \
  bash scripts/operations/release-migrate.sh
```

Production uses `APP_ENV=production` and production-scoped credentials. The script:

1. rejects development/test and unknown environments;
2. requires both runtime and migrator database URLs;
3. requires a full 40-character commit SHA as `DEPLOY_REVISION`;
4. records non-secret structured start/complete events containing only environment and revision;
5. derives `MIGRATION_APPLIED_BY` as `release:<environment>:<revision>` unless an explicit audit identity is supplied;
6. invokes the canonical `pnpm db:migrate` runner, which verifies migration sequence/checksums, serializes migrators with a PostgreSQL advisory lock, wraps each pending migration in a transaction and verifies the final migration history.

## Initial administrative bootstrap

A newly created staging/production database has no authorized admin principal. The first principal cannot be created through the ordinary Tier 4 `admin.role.assign` workflow because that workflow itself requires an already-authorized proposer and independent approval.

For a genuinely new environment only, run the one-time `pnpm ops:bootstrap:admin` ceremony documented in `docs/operations/initial-admin-bootstrap.md`. It uses the schema-owning migrator credential, creates one `OWNER_SECURITY_ADMIN` principal with a GLOBAL scope, appends audit evidence and leaves an immutable bootstrap marker. Exact replay is idempotent; conflicting identity/release/environment state fails closed. After this marker exists, later admin role changes return to the normal governed admin operation surface.

The remaining deployment order is:

1. bootstrap/rotate PostgreSQL roles with `db/bootstrap/roles.sql` when required;
2. run `scripts/operations/release-migrate.sh` while runtime traffic is stopped for schema-changing releases;
3. reconcile runtime grants with `db/bootstrap/runtime_grants.sql` as the migrator role;
4. on a genuinely new environment only, execute the initial administrative bootstrap ceremony;
5. run `pnpm db:verify` using the runtime credential;
6. execute post-deploy smoke tests;
7. only then admit normal traffic.

## CI evidence

Permanent CI exercises the controlled migration command against a real disposable PostgreSQL database using `APP_ENV=staging`, distinct migrator/runtime roles and the exact CI commit SHA. The same proof reconciles runtime grants, verifies the schema through the restricted runtime role and exercises the one-shot initial admin bootstrap with exact replay/conflict/privilege checks.

This provides repository evidence for the environment boundary, controlled migration step and bootstrap mechanism without pretending that an external staging or production host exists.

## Deliberately still open

This foundation does **not** by itself close these Phase 17 requirements:

- 17.2: an actual staging environment with PostgreSQL and production-equivalent adapter configuration where possible;
- 17.3: an actual reproducible deployment pipeline connected to an approved runtime target.

Those items close only after a real deployment target is configured and proven. No workflow or document may substitute a simulated target for that evidence.
