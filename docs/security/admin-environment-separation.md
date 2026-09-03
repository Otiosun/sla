# Admin staging / production separation

## Status

This document defines the deployment evidence required to close Control Center checklist item F2.16.
Repository safeguards now bind durable administrative sessions and governed revoke-all operations to an
explicit trusted environment. Those safeguards prevent accidental session-state bleed when environments
share infrastructure, but they do **not** prove that staging and production are materially separate in the
hosting and identity providers.

F2.16 remains open until the real deployments satisfy and evidence the requirements below.

## Repository guarantees

The Admin API currently enforces these application-level boundaries:

- authenticated request context carries one server-owned environment: `development`, `staging` or
  `production`;
- a durable Access session is bound to its principal, environment, token fingerprint and verified temporal
  claims;
- one fingerprint cannot be reused under another environment;
- `admin.session.revoke_all` receives its environment from trusted authenticated request context rather
  than browser authority;
- revoke-all counts, revokes and audits sessions only in that environment;
- anti-resurrection cutoffs are keyed by `(principal_id, environment)`, so a staging cutoff cannot deny a
  production Access assertion merely because both principals share the same internal id;
- a governed staging revoke-all cannot change production session rows.

These are defense-in-depth invariants. They are not a substitute for deployment separation.

## Required deployment separation

### Administrative origin

Staging and production must have distinct administrative origins. Do not use one origin with a browser
switch, query parameter, path toggle or client-controlled header to select the environment.

Examples of acceptable shape are two distinct hostnames such as an admin staging hostname and an admin
production hostname. The exact production names are deployment configuration and should not be hard-coded
into domain logic.

### Cloudflare Access applications and audiences

Each environment must have its own Access application identity boundary and its own audience values.
Within each environment, the standard and privileged audiences must also remain distinct as required by
`admin-access-step-up.md`.

Consequently, the four logical audience roles are independent:

- staging standard;
- staging privileged;
- production standard;
- production privileged.

Do not reuse a production audience in staging or a staging audience in production. Do not treat a different
path on the same Access application as sufficient credential separation unless provider evidence proves
that the issued audience and policy boundary are actually distinct.

### Credentials and secrets

Staging and production deployment secrets must be independently managed. At minimum this includes the
Admin API Access audience configuration, any Tunnel/AOP credentials, database credentials and deployment
platform credentials used to reach each environment.

Secrets must stay in provider secret storage. They must not be copied into Git, Drive, screenshots, CI
logs or application logs as evidence.

### Session and cookie boundary

The provider setup must not make a staging administrative session usable as a production administrative
session. Browser cookies, Access assertions and origin-side durable session state must remain bound to the
appropriate environment.

Application-level environment checks are defense in depth; the identity provider and hostname topology
must provide the primary separation.

### Data plane

Production and staging should use separate databases or materially isolated database resources and
credentials. If any shared infrastructure is unavoidable, role grants and connection strings must prevent
staging runtime credentials from mutating production state and vice versa.

A shared database with only an application `environment` column is not considered sufficient proof of
production/staging isolation.

## Evidence required before F2.16 promotion

Capture non-secret evidence proving all of the following:

1. distinct staging and production administrative origins exist;
2. each origin resolves to the intended environment and cannot select the other environment through
   browser-controlled input;
3. staging and production use distinct standard Access audience identifiers;
4. staging and production use distinct privileged Access audience identifiers;
5. the privileged audience is also distinct from the standard audience inside each environment;
6. a staging Access assertion is rejected by production and a production assertion is rejected by staging;
7. staging and production deployment secrets/credentials are independently configured;
8. staging runtime database credentials cannot mutate production state, and production credentials are not
   present in staging;
9. a staging durable session cannot be replayed in production;
10. governed revoke-all in staging leaves production administrative sessions usable, and the reverse also
    holds;
11. no secret, raw Access JWT, cookie, private key or database password appears in the evidence.

Until these checks run against real provider/deployment resources, F2.16 remains canonically open even if
all repository tests pass.
