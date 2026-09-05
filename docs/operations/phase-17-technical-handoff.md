# Phase 17 — Technical Handoff — Release Candidate

Status: **pre-final handoff for checklist item 17.17**.

This document consolidates architecture, canonical decisions, known limitations, unsupported features and maintenance entry points for the Pokémon WhatsApp RPG bot. It is intentionally a **release-candidate handoff**, not the final 17.17 sign-off.

17.17 may only close after the final release/tag and Drive snapshot are known and this document is updated with those immutable coordinates. Creating or merging this document changes no release percentage by itself.

## 1. Scope

This handoff covers the backend/runtime in repository `Otiosun/sla`:

- deterministic Pokémon RPG engine;
- PostgreSQL persistence and migrations;
- WhatsApp/Baileys runtime;
- Reception, registration/ficha and player activation;
- world, encounter, battle, capture, economy, inventory and progression domains;
- PVE/PVP mechanics currently represented by the canonical domain flows;
- admin Registry, risk operations and Player 360;
- durable messaging/outbox behavior;
- operational tooling, migrations, backup, observability and release contracts.

This handoff does **not** redefine the public Pokémon Hub website or a separate Pokémon Control Center frontend. Those surfaces may consume or invoke shared backend operations in their own projects, but they are not this repository's code truth.

## 2. Current release-candidate coordinates

Preparation baseline:

```text
Repository: Otiosun/sla
Branch: main
Git SHA: 168be8f7d5897ade86a444aa376d99418c406951
Tree: 9fc015df63a8d8cdd644efbb069344e434fd0f4c
Node: 24.19.0
pnpm: 11.23.0
PostgreSQL compatibility baseline: 18.6
Canonical migration tip: 0033_pvp_challenge_lifecycle.sql
Package manifest version before final release: 0.0.0 (private package)
Release progress at handoff preparation: 98.00%
```

Final 17.17 sign-off must replace/complete:

```text
Final release tag/version: PENDING 17.15
Final release Git SHA: PENDING 17.15
Final tree SHA: PENDING 17.15
Final schema/migration tip: PENDING final release revalidation
Final active content release: PENDING 17.16 snapshot
Final active ruleset: PENDING 17.16 snapshot
Final production/runtime deployment reference: PENDING release acceptance
Final Drive snapshot reference: PENDING 17.16
```

Do not convert the current private package version `0.0.0` into a release-version claim. Checklist item 17.15 defines the release/tag separately.

## 3. Sources of truth

Operational rule:

- **GitHub is code truth**: source, migrations, workflows, tests, PRs, tags and immutable SHAs.
- **Google Drive is decision/release truth**: checklist, canonical checkpoints, accepted decisions, release evidence and continuity.

Never use a stale local checkout, old WIP database, old chat description or abandoned branch as a higher authority than canonical `main` + current Drive decisions.

## 4. Architecture map

The source tree is deliberately separated by responsibility:

### `src/modules`

Domain/application behavior. Current module families include, among others:

- `admin`;
- `anti-abuse`;
- `battle`;
- `capture`;
- `catalog`;
- `community`;
- `economy`;
- `encounter`;
- `inventory`;
- `messaging`;
- `narrative` / `narrative-ai` boundaries;
- `player`;
- progression/world/Pokémon-related domain slices represented by the current tree.

Business invariants belong in domain/application services, not in transport handlers or ad-hoc SQL.

### `src/platform`

Infrastructure implementations such as PostgreSQL, logging, metrics, persistence adapters and provider-facing infrastructure.

### `src/runtime`

Long-running runtime composition and worker/provider lifecycle.

### `src/adapters`

External/transport boundaries. WhatsApp input/output adaptation must remain outside core mechanical authority.

### `src/operations`

Operational/application coordination boundaries used by controlled runtime or operator flows.

### `src/shared-kernel`

Cross-domain primitives and shared deterministic contracts. Avoid turning this layer into a catch-all for feature-specific behavior.

### `src/main.ts`

Runtime composition entry point. Production behavior should be assembled here through typed boundaries rather than hiding infrastructure construction inside domains.

## 5. Core engineering decisions

### 5.1 PostgreSQL is authoritative durable state

Durable gameplay/admin state is PostgreSQL-backed. In-memory state may coordinate a live process but cannot become the only authority for a result that must survive retries/restarts.

### 5.2 Migrations are immutable history

Canonical migrations currently run from `0001` through `0033`.

Rules:

- never renumber an applied canonical migration;
- never rewrite an applied migration to make a local divergent database appear compatible;
- migration checksum/order divergence fails closed;
- staging/production migration operations use a dedicated migrator credential distinct from the restricted runtime role;
- runtime processes must not receive `MIGRATOR_DATABASE_URL` as a normal dependency.

### 5.3 Durable action before delivery

For user/admin workflows, database state is authority. External message delivery is not authority.

Canonical pattern:

1. validate and commit domain/admin state;
2. enqueue durable delivery/outbox evidence;
3. send/retry WhatsApp delivery;
4. never roll back authoritative business state merely because a message transport failed after commit.

### 5.4 Idempotency and revision protection

Retried work must converge rather than duplicate effects. High-impact admin operations additionally use their registered policy for reason, expected revision, simulation, confirmation and/or independent approval.

### 5.5 Fail closed

Unknown environments, unknown groups, unknown/unregistered admin operations, invalid migration history, missing critical release configuration and unsafe authorization contexts are rejected rather than guessed.

## 6. WhatsApp runtime

Canonical provider: **Baileys** (`@whiskeysockets/baileys` currently pinned in the package manifest).

Important boundaries:

- only one intended runtime may own a given accepted WhatsApp session at a time;
- staging and production must not share WhatsApp auth/session state;
- WhatsApp group-admin status is not RPG administrative authority;
- provider identity is mapped through application identity/admin policy rather than trusted directly;
- message bodies/provider identifiers must not be sprayed into logs/metrics.

### Auth persistence

WhatsApp auth/session state is persisted encrypted in PostgreSQL. Application encryption key material is external secret configuration and must not be stored in plaintext alongside encrypted rows.

Moving encrypted auth rows between compatible environments requires deliberate custody of the same encryption key/version. Never run two workers against copied live credentials.

## 7. Reception, registration and activation

Canonical product flow:

- Reception is the official WhatsApp entry/validation gate;
- player may use guided registration or full ficha against the same draft model;
- ordinary answers mutate the active session; explicit save persists draft state;
- final confirmation creates/submits an immutable review revision;
- human ADM may approve, request changes or reject;
- starter before approval is **intent only**;
- provisioning after approval creates/ensures the actual mechanic state and starter;
- activation reaches `PlayerAccess=ACTIVE` only after provisioning invariants pass;
- returning ACTIVE players must not restart onboarding.

Current product boundaries:

- one WhatsApp number = one active character for now;
- canonical region is **Zhoulia**; player is not asked to choose among regions in the current release scope;
- approval announces activation in Reception;
- automatic addition to every GAME/PVP/COMMUNITY group is not part of the current accepted flow.

## 8. Community/group authorization

Group roles include canonical categories such as:

- RECEPTION;
- GAME;
- PVP;
- COMMUNITY;
- STAFF.

Capabilities are registered separately from display names. Unknown groups fail closed.

Reception is intentionally constrained and must not silently acquire WORLD/PVE/PVP mechanical authority merely because a chat looks like the right group.

Reception staff assignment is routing/responsibility metadata; it does not itself grant RPG administrative authority.

## 9. Admin architecture

Administrative authority is modeled through active AdminPrincipals, capabilities, scopes and registered typed operations.

The Admin Registry is the executable authority boundary. A capability key existing in a catalog does not mean a missing/unregistered operation can be invoked.

Risk policies may require:

- reason;
- expected revision;
- simulation;
- proposer confirmation;
- one or more independent approvals.

Tier 4 dual-control must not permit proposer self-approval when independent approval is required.

Use the registered admin/domain operation surface. Raw SQL is not an acceptable ordinary admin interface.

Canonical operator reference:

- `docs/operations/admin-operator-manual.md`;
- `docs/operations/phase-17-player360-risk-uat-runbook.md` for final human risk UAT.

## 10. Player 360

Player 360 is a cross-domain read model/view, not a parallel gameplay source of truth.

Sensitive identity access requires its dedicated capability/scope. Ordinary player read does not implicitly grant sensitive identity visibility.

Known explicit unsupported Player 360 sections in the current contract:

- `COOLDOWNS`;
- `PUNISHMENTS_FLAGS`.

Unsupported coverage must remain explicit. Do not return fabricated completeness simply to make the panel look finished.

## 11. Content and rules

Content/catalog state is release-aware and durable. Mechanical code and content release coordinates are separate pieces of release evidence.

Final release snapshot must record:

- code SHA/tag;
- schema/migration tip;
- active content release;
- active ruleset.

Do not infer content/ruleset IDs from an old checkpoint when producing the final 17.16 snapshot; read the accepted environment at that time.

## 12. Release/deployment contract

Current release hardening favors immutable artifacts and exact revision evidence.

For the current staging validation path:

- Railway is the canonical staging runtime target;
- runtime image is addressed by immutable Git SHA/digest rather than mutable `latest`/`main` as release proof;
- exactly one Baileys worker is intended;
- previous worker is removed before replacement connects, accepting brief staging downtime to avoid duplicate session ownership;
- `DEPLOY_REVISION` must match the exact candidate SHA;
- Railway `SUCCESS` alone is insufficient: provider-live smoke must also prove the exact revision/session healthy.

Canonical references:

- `docs/operations/environments-release.md`;
- Railway staging runtime/operator documentation in `docs/operations`;
- `ops:smoke:application` for the canonical application smoke path.

## 13. Backup and disaster recovery

Repository backup primitives are implemented and CI-proven, but **production backup validation is not complete at this handoff preparation point**.

Known current blocker:

- scheduled production backup runs inspected on 2026-09-04 and 2026-09-05 failed closed because production DB/storage configuration reached the workflow empty;
- no defect was identified in the backup script from those failures;
- external production backup storage/secrets and real alert routing still require configuration/proof.

Do not call CI logical backup proof a production backup.

Canonical references:

- `docs/operations/backup-restore.md`;
- `docs/operations/disaster-recovery.md`;
- `docs/operations/phase-17-production-backup-alerts-validation.md`.

## 14. Observability and incident response

The codebase has provider-neutral structured metrics and alert policy. A monitoring SaaS/backend is deliberately not hard-coded into domain logic.

Current baseline alert classes cover:

- runtime latency/error ratio;
- messaging queue age;
- database errors;
- WhatsApp disconnect duration;
- backup age/failure.

A calculated `AlertSignal` is not equivalent to an operator receiving a notification. Phase 17.13/17.18 require external monitoring/routing evidence.

Canonical references:

- `docs/operations/observability-alerting.md`;
- `docs/operations/incident-response.md`.

## 15. Security and privacy boundaries

Current repository controls include:

- environment files excluded from Git except documented example configuration;
- strict TLS contract; do not introduce verification bypasses;
- structured logging/redaction boundary;
- runtime/migrator PostgreSQL role separation;
- typed/admin authorization instead of arbitrary patching;
- append-only/auditable administrative evidence expectations;
- explicit secret rotation policy.

Final provider/account access review remains external to repository-only evidence.

Canonical references:

- `docs/security/phase17-final-privacy-secrets-access-review.md`;
- `docs/security/secrets-rotation-policy.md`;
- `docs/security/admin-surface-review.md`.

## 16. Local development and verification

Required toolchain from repository manifests:

```text
Node 24.19.0
pnpm 11.23.0
```

Useful commands:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm db:migrate
pnpm db:verify
pnpm ops:docs:verify
pnpm ops:smoke:application
```

Environment-specific operator commands also include:

```bash
pnpm ops:bootstrap:admin
pnpm ops:bootstrap:content
pnpm ops:bootstrap:whatsapp
```

These commands are not permission bypasses. Production/staging preconditions in their wrappers remain authoritative.

## 17. Local database warning

Do not point current canonical `main` at a known divergent historical WIP database merely because its schema appears similar.

A database containing migrations from an abandoned numbering/history can fail canonical migration verification even when some tables look compatible. Preserve old data, create a fresh canonical database, migrate in canonical order, then copy only deliberately compatible data through reviewed procedures.

Never rewrite migration history to make an old local database look canonical.

## 18. Maintenance decision tree

### Code change

1. revalidate current `main`;
2. branch from exact canonical SHA;
3. implement through domain/platform boundaries;
4. run relevant local/permanent proof;
5. open PR;
6. require canonical workflows on exact head;
7. merge with expected head protection where available;
8. require post-merge main workflows;
9. update Drive checkpoint only after evidence exists.

### Schema change

In addition to normal code change:

1. add the next immutable numbered migration;
2. never edit previous applied migrations;
3. preserve runtime/migrator role split;
4. verify forward migration and rollback/restore expectations;
5. update final schema coordinate when released.

### Content change

Use the content release lifecycle rather than silently mutating accepted production content behind a release coordinate.

### Admin intervention

Use the registered operation + reason/revision/risk gates. Do not patch gameplay/admin tables directly as the ordinary solution.

### Incident

Preserve evidence, correlation context and original failed state. Follow `incident-response.md`; do not make telemetry look healthy by deleting evidence or weakening thresholds.

## 19. Known release blockers/open gates at preparation time

The following remain intentionally open and therefore prevent this document from being called final release handoff:

- **17.5** — provider-live staging post-deploy smoke still requires accepted external evidence;
- **17.7** — human WhatsApp client/admin UAT still requires execution/evidence;
- **17.10** — human Player 360/risk-operation UAT still requires execution/evidence;
- **17.13** — production backup + real alert routing not yet validated;
- **17.14** — final provider/account privacy/secrets/access review not yet completed;
- **17.15** — final tag/release/changelog not yet created;
- **17.16** — final Drive snapshot with code/schema/content/ruleset coordinates not yet produced;
- **17.18** — initial monitoring window not yet executed;
- **17.20** — final acceptance cannot occur while the preceding blockers remain.

Checklist item 17.19 (post-1.0 backlog separation) is already complete and must stay outside release-acceptance scope.

## 20. Known product limitations / deliberate unsupported scope

Do not treat these as bugs merely because a future product may expand them:

- one active character per WhatsApp number in the current release scope;
- only Zhoulia is the canonical onboarding region in the current release scope;
- starter selection before human approval is intent, not actual Pokémon creation;
- approval does not auto-enroll the player into every other community/game group;
- Player 360 currently declares `COOLDOWNS` and `PUNISHMENTS_FLAGS` unsupported;
- external monitoring provider/routing is not embedded in the mechanical core;
- public site and separate Control Center frontend are outside this repository's code scope;
- post-1.0 narrative affordance work belongs to the separated backlog unless explicitly promoted through a new accepted scope.

## 21. What a future maintainer must never do

- never weaken TLS with `rejectUnauthorized:false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `sslmode=no-verify` or equivalents;
- never run two workers on the same live WhatsApp session;
- never commit `.env`/database/storage/WhatsApp key material;
- never use a migration-role credential as the long-running runtime login;
- never rewrite or renumber applied migrations;
- never bypass admin risk gates with raw SQL or an unregistered batch shortcut;
- never infer RPG authority from WhatsApp group-admin status;
- never treat delivery success as the source of business truth;
- never mark a human/provider gate complete using only static CI/documentation evidence;
- never erase original incident/audit evidence during compensation or cleanup.

## 22. Canonical operator documentation index

Start here depending on the problem:

| Need | Canonical reference |
| --- | --- |
| Environment/release contract | `docs/operations/environments-release.md` |
| Admin operation usage | `docs/operations/admin-operator-manual.md` |
| Initial admin bootstrap | `docs/operations/initial-admin-bootstrap.md` |
| Backup/restore | `docs/operations/backup-restore.md` |
| Production backup + alert validation | `docs/operations/phase-17-production-backup-alerts-validation.md` |
| Disaster recovery | `docs/operations/disaster-recovery.md` |
| Observability/alerts | `docs/operations/observability-alerting.md` |
| Incident handling | `docs/operations/incident-response.md` |
| Audit retention | `docs/operations/audit-retention.md` |
| WhatsApp human UAT | `docs/operations/phase-17-whatsapp-uat-runbook.md` |
| Player 360/risk UAT | `docs/operations/phase-17-player360-risk-uat-runbook.md` |
| Final security/access review | `docs/security/phase17-final-privacy-secrets-access-review.md` |
| Secret rotation | `docs/security/secrets-rotation-policy.md` |

Use the exact repository revision associated with the release when reading these documents during incident/recovery work.

## 23. Finalization procedure for 17.17

After 17.15 and 17.16 are legitimately complete:

1. re-read canonical `main` and final tag;
2. verify tag points to the intended immutable release SHA;
3. verify canonical migration tip/schema version;
4. read accepted environment's active content release and ruleset;
5. link the final Drive snapshot;
6. update section 2 with those immutable coordinates;
7. update section 19 to remove only gates that have actual evidence;
8. confirm known limitations/unsupported scope still matches the released code/product decisions;
9. run `pnpm ops:docs:verify` and the canonical CI matrix on the exact handoff revision;
10. only then mark checklist item 17.17 complete.

Until that ceremony occurs, this document is **prepared handoff material**, not final acceptance evidence.
