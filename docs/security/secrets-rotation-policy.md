# Secrets and rotation policy

## Scope

This policy covers runtime database credentials, migrator credentials, WhatsApp provider/auth material, backup storage credentials, signing/encryption keys, CI/CD credentials, and any future third-party provider token used by CLOVER.

A value is a secret when disclosure can authenticate, authorize, decrypt, sign, impersonate, or provide privileged infrastructure access. Secret values do not belong in Git, Dockerfiles, fixtures, screenshots, Drive planning documents, logs, metric labels, issue/PR text, or chat transcripts.

## Source of truth

Production and staging secrets must be injected by the deployment secret/environment layer. The repository contains only variable names, validation rules, and non-secret examples.

`.env.example` is documentation, not a credential store. Placeholder values such as `CHANGE_ME` are intentionally non-operational and must never be promoted to staging/production.

Application logs already redact common credential/token fields. Metrics introduced by Phase 16 use bounded operational labels only; secret values, player identifiers, database URLs, WhatsApp JIDs, phone numbers, idempotency keys, and arbitrary exception strings are forbidden as metric labels.

## Ownership and least privilege

Each secret has exactly one operational owner and one documented consumer boundary. Credentials must grant the minimum capability required by that consumer.

- Runtime PostgreSQL credentials may execute runtime operations only and must remain distinct from migrator credentials in staging/production.
- Migrator credentials are used only during controlled schema migration/verification.
- Backup credentials are write/list/delete scoped only to the configured backup bucket/prefix when the storage provider permits it. They are not application runtime credentials.
- WhatsApp auth material is consumed only by the WhatsApp adapter/auth persistence boundary.
- CI credentials are repository/environment scoped and must not be copied into local source files.

Shared human accounts and multi-purpose infrastructure tokens are prohibited when a provider supports service identities.

## Rotation classes

| Class | Examples | Maximum routine age | Rotation requirement |
| --- | --- | ---: | --- |
| A — infrastructure privileged | migrator DB, backup storage, deployment credentials | 90 days | rotate at or before 90 days |
| B — runtime/provider | runtime DB, WhatsApp/provider credentials, external API keys | 90 days | rotate at or before 90 days, or sooner if provider mandates |
| C — signing/encryption | signing keys, encryption material | 180 days | planned rollover with overlap where protocol supports it |
| Emergency | any suspected/confirmed exposure | immediate | revoke/rotate without waiting for routine window |

A provider-enforced lifetime shorter than this table wins. A secret that cannot be rotated safely must be treated as an operational risk and escalated before production use.

## Standard rotation procedure

1. Identify the secret owner, consumers, environment, and least-privilege scope.
2. Create a replacement through the provider/secret manager; never generate or exchange the value in Git/Drive/chat.
3. Where the protocol supports overlap, deploy the new credential while the old credential remains valid for the shortest practical verification window.
4. Verify health using non-secret evidence: application readiness, DB connectivity, provider connectivity, backup success, and relevant error metrics.
5. Revoke the old credential.
6. Verify the old credential no longer authenticates when the provider supports a safe check.
7. Record only metadata in the rotation log: secret identifier/class, environment, owner, rotated-at time, revoked-at time, result, incident/change reference. Never record the value.

For single-key providers with no overlap, use a controlled maintenance/change window and have an explicit rollback credential procedure before rotation starts.

## Emergency rotation

Suspected disclosure, accidental commit, unexpected credential use, compromised workstation/runner, or provider breach triggers emergency handling:

1. contain access and identify affected scopes;
2. revoke the exposed credential first when continued use is unsafe;
3. issue a least-privilege replacement through the secret manager/provider;
4. redeploy consumers;
5. search logs/audit trails for misuse without echoing the secret;
6. invalidate derived sessions/tokens where applicable;
7. create an incident record and complete post-incident review.

Removing a secret from the latest Git commit is **not** revocation. If a credential ever reached Git history or another unauthorized channel, treat it as compromised and rotate it.

## CI and repository controls

- Workflow permissions remain explicit and minimal.
- Third-party GitHub Actions must be pinned to immutable commit SHAs.
- Production dependency audit remains a permanent security gate.
- New configuration must fail closed when a required production secret is absent.
- Tests use test-only credentials that cannot authenticate to production resources.
- Secret values must never be used as metric labels or structured log context.

## Rotation evidence

The acceptable evidence is metadata, never the value itself:

- secret logical identifier/class;
- environment and owner;
- provider/service;
- creation/rotation timestamp;
- prior credential revocation timestamp;
- verification result;
- incident/change reference when applicable;
- next routine rotation deadline.

Operators review the rotation register at least monthly. Any Class A/B secret older than 90 days or Class C secret older than 180 days is an operational alert/action item.

## Definition of done for a new secret

A new secret is not production-ready until its owner, consumer boundary, least-privilege scope, injection path, rotation class, emergency revocation path, and non-secret verification method are all documented.