# Initial administrative bootstrap

## Purpose

This is the one-time ceremony that creates the first administrative principal in a new staging or production database. It is intentionally separate from the ordinary `AdminService` mutation surface: normal `admin.role.assign` is a Tier 4 operation that requires an already-authorized proposer, confirmation and independent approval, so it cannot authorize the first principal without creating a bootstrap paradox.

The bootstrap is not a standing backdoor. After the durable marker exists, the command accepts only an exact replay of the same environment, deployment revision and external identity. Any conflicting request fails closed. All later administrative role management must use the governed admin operation registry.

## Preconditions

1. `APP_ENV` is exactly `staging` or `production`.
2. The target schema is current.
3. `DATABASE_URL` is the restricted runtime credential.
4. `MIGRATOR_DATABASE_URL` is a distinct role targeting the same PostgreSQL database and owning the application schema.
5. `DEPLOY_REVISION` is the exact 40-character Git SHA being deployed.
6. No unmarked `admin_principals` row exists.
7. The operator has selected one stable namespaced external identity reference, for example `whatsapp:<provider-id>` or another future authentication-provider namespace. The value is stored in `admin_principals.identity_ref` but is not emitted by the bootstrap command.

## Confirmation binding

The operator must set:

```text
ADMIN_BOOTSTRAP_CONFIRMATION=bootstrap-initial-admin:<APP_ENV>:<DEPLOY_REVISION>
```

The confirmation is deliberately environment- and revision-specific. A staging command copied into production, or a command copied from another release SHA, is rejected before database mutation.

## Command

Use the deployment secret/environment layer rather than committing values to Git, Drive, shell scripts or documentation.

```bash
APP_ENV=staging \
DATABASE_URL="$STAGING_RUNTIME_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$STAGING_MIGRATOR_DATABASE_URL" \
DEPLOY_REVISION="<full-40-char-git-sha>" \
ADMIN_BOOTSTRAP_IDENTITY_REF="$INITIAL_ADMIN_IDENTITY_REF" \
ADMIN_BOOTSTRAP_CONFIRMATION="bootstrap-initial-admin:staging:<full-40-char-git-sha>" \
  pnpm ops:bootstrap:admin
```

Production uses production-scoped credentials, `APP_ENV=production`, and a production-bound confirmation string.

## Atomic effects

Under one PostgreSQL transaction and an advisory bootstrap lock, the command:

1. verifies it is running as the schema-owning migrator role;
2. refuses to adopt any pre-existing unmarked admin principal;
3. reconciles the canonical capability/role registry and fails on capability risk drift;
4. creates exactly one active `admin_principals` row;
5. grants exactly the `OWNER_SECURITY_ADMIN` role;
6. creates exactly one active `GLOBAL` scope;
7. appends a Tier 4 `SYSTEM` audit event without embedding the external identity;
8. writes the immutable `admin_initial_bootstrap_state` marker with environment, deploy SHA and correlation ID.

The ordinary runtime role receives only `SELECT` on the bootstrap marker. INSERT, UPDATE, DELETE and TRUNCATE are explicitly revoked and verified by `runtime_grants.sql`.

## Replay and failure behavior

An exact rerun with the same environment, SHA and identity is idempotent and returns the original principal/correlation IDs with `replayed=true`. A different identity, different environment, different release SHA, drifted bootstrap state, or pre-existing unmarked principal is rejected. The command does not silently repair or adopt ambiguous administrative state.

## Output and secret hygiene

Success output contains only the event name, principal UUID, role slug, environment, deployment revision, correlation UUID and replay flag. The external identity reference is never printed by the command. PostgreSQL passwords and future provider/session secrets remain outside logs and source control.

## What this does not do

- It does not create a web admin panel or authentication transport.
- It does not pair the WhatsApp provider session.
- It does not make staging or production infrastructure exist.
- It does not replace the Tier 4 governance required for later role assignments.

Those are separate operational boundaries and remain subject to their own Phase 17 evidence.
