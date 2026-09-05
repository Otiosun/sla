# Phase 17 — Final Privacy, Secrets and Access Review

Status: **review runbook + repository-side evidence for checklist item 17.14**.

Creating or merging this document **does not close 17.14**. The repository can prove important controls in the current tracked revision, but it cannot by itself prove who currently has access to Railway, Supabase/PostgreSQL, GitHub, Google Drive, backup storage, or the live WhatsApp session/key material. Final PASS therefore requires the provider/account review in this document to be performed by a human operator and recorded with evidence.

## 1. Revision under review

Repository-side review baseline:

- repository: `Otiosun/sla`;
- branch: `main`;
- Git SHA: `6b62a3b404b4d5627628509028d22834180c2681`;
- tree: `4e7df8c6325d9c928961d7a73621d0a982b0ef72`;
- release progress at preparation time: **98.00%**;
- 17.14 remains open until provider/account evidence is completed.

Record the final human review context before closure:

```text
Review date/time:
Reviewers:
Target environments:
Git SHA actually reviewed:
Railway project/service reference:
Supabase/PostgreSQL project reference:
GitHub repository reference:
Backup storage reference:
Google Drive operational folder/doc reference:
WhatsApp session reference: [safe reference only]
Evidence bundle/reference:
```

If the deployed revision changes after this review begins, record the change and repeat any repository/provider check affected by the new revision.

## 2. Current tracked-tree review — repository evidence

Repository-side findings at the baseline revision are **PASS for the current tracked tree**, subject to the limitations in section 3.

### 2.1 Environment and secret-file hygiene

Verified controls/findings:

- `.gitignore` ignores `.env` and `.env.*` while explicitly allowing `.env.example`;
- `.env.example` documents configuration with placeholders rather than live credentials;
- no tracked private-key material was found under the reviewed current tree using private-key marker/path checks;
- no tracked `.key`, `.pfx`, `.p12`, `.pem`, `.bak`, or `.dump` artifact was identified in the reviewed current tree searches;
- no literal `WHATSAPP_AUTH_KEY_BASE64=` assignment was found in the reviewed code index;
- no literal `postgresql://` connection URL was found in the reviewed code index;
- `certs/supabase/prod-ca-2021.crt` is a public CA certificate, not a private credential, and is appropriate to track.

A zero-result current-tree/code-index search is useful evidence but **is not proof that Git history never contained a secret**. Historical exposure must be handled separately in section 5.

### 2.2 TLS integrity

The reviewed repository contains no known occurrence of the prohibited bypass patterns:

- `rejectUnauthorized:false`;
- `rejectUnauthorized: false`;
- `NODE_TLS_REJECT_UNAUTHORIZED` used as a bypass;
- `sslmode=no-verify`.

The release/runtime path is expected to keep certificate verification enabled and use the pinned/accepted CA path where required. Any temporary TLS bypass is a release blocker.

### 2.3 Structured logging and redaction

The production logging boundary:

- uses structured logging;
- recursively redacts sensitive keys/values;
- includes redaction coverage for tokens, secrets, passwords, auth/cookie material, phone/JID/external identity data, WhatsApp auth/key/credential fields and PII-like values;
- constrains serialized error output;
- is protected by CI against direct `console.*` / `process.stdout` / `process.stderr` production logging outside the approved logging boundary;
- has an explicit regression test for known libsignal-sensitive logging paths.

Repository-side verdict: **PASS**, subject to live-log sampling in section 6.

### 2.4 Database least privilege

The reviewed database bootstrap/grant model separates migration authority from runtime authority and explicitly constrains runtime grants/revokes.

Required final evidence:

- runtime process uses the runtime role, not migrator/superuser credentials;
- migration operation uses the dedicated migrator path;
- provider-side PostgreSQL roles match the intended split;
- no stale or emergency broad role remains active without documented justification.

Repository-side verdict: **PASS for the policy/SQL model; provider verification required**.

### 2.5 Administrative authorization surface

The reviewed admin architecture:

- exposes typed operations through the Admin Registry rather than arbitrary SQL/object patching;
- validates strict input schemas;
- requires capability + scope + registered operation policy;
- fails closed for unknown/unregistered operations;
- supports expected revision, simulation, confirmation and independent approval according to each persisted operation policy;
- prohibits treating WhatsApp group-admin status as RPG administrative authority;
- uses append-only/auditable administrative operation state.

Repository-side verdict: **PASS for architecture; live principal/access inventory required**.

### 2.6 Audit retention and immutability

The repository contains an explicit audit-retention policy and database-side immutability expectations for audit records.

Final provider/operator review must verify that:

- retention settings/storage actually match the policy;
- audit records are available for the accepted operational window;
- no operator has been given a convenience path that silently deletes or rewrites audit evidence;
- backup/restore procedures preserve required audit evidence.

## 3. Limits of repository evidence

The current repository review **cannot establish** any of the following on its own:

- who currently belongs to the Railway project;
- who can view/edit Railway variables or deploy production services;
- who currently has Supabase dashboard/database access;
- which PostgreSQL credentials/roles are currently issued and still valid;
- who is a GitHub collaborator or can manage Actions/environments/secrets;
- whether a historical credential was exposed in an old commit, issue, artifact, screenshot or external chat;
- who has access to backup storage;
- who can read/edit the canonical Drive documents/folders;
- who controls the live WhatsApp account/session or possesses its application encryption key;
- when each live secret was actually last rotated.

These are mandatory human/provider checks, not optional polish.

## 4. Provider/account access review

For each provider, capture owner, active members, privilege level, reason for access, last review date, action taken, and evidence reference. Never copy secret values into the evidence bundle.

### 4.1 Railway

- [ ] enumerate all project members/service access;
- [ ] remove stale or unexplained access;
- [ ] verify only intended operators can change production variables;
- [ ] verify deploy authority is limited to intended operators/integration identity;
- [ ] verify production/staging variables are separated;
- [ ] verify no secret is duplicated into a public build log or repository file;
- [ ] verify only one intended WhatsApp runtime owns the accepted session at a time.

### 4.2 Supabase / PostgreSQL

- [ ] enumerate dashboard/project members;
- [ ] enumerate relevant application/migration/database roles;
- [ ] verify runtime role is least privilege;
- [ ] verify migrator credentials are not used by normal runtime;
- [ ] remove/revoke stale credentials or broad roles;
- [ ] verify network/TLS settings do not depend on verification bypasses;
- [ ] verify production/staging databases and credentials are distinct where required.

### 4.3 GitHub

- [ ] enumerate repository collaborators and effective write/admin access;
- [ ] verify Actions/environment permissions are appropriate;
- [ ] verify production-affecting secrets are owned/injected through the intended secret layer;
- [ ] review secret-scanning/security findings where available;
- [ ] review historical incidents or suspected exposures and confirm affected credentials were revoked/rotated;
- [ ] verify no stale deploy token/integration identity remains unnecessarily active;
- [ ] preserve least-privilege workflow permissions and immutable action pins.

### 4.4 Backup storage

- [ ] identify the backup storage owner/system;
- [ ] enumerate principals that can read backups;
- [ ] enumerate principals that can delete/overwrite backups;
- [ ] verify backup credentials are separate from ordinary runtime credentials where applicable;
- [ ] verify retention and restore evidence required by Phase 17.13;
- [ ] remove stale access.

### 4.5 Google Drive operational truth

- [ ] review sharing of canonical checklist/checkpoint/handoff material;
- [ ] remove stale editors/viewers who no longer need access;
- [ ] verify Drive contains operational metadata/evidence, not live secrets;
- [ ] verify links/evidence shared for handoff do not expose credentials or unnecessary player PII.

### 4.6 WhatsApp session and application encryption key

- [ ] identify who controls the WhatsApp account/paired devices;
- [ ] review paired devices and remove unknown/stale devices;
- [ ] identify the custodian of `WHATSAPP_AUTH_KEY_BASE64` without recording the key itself;
- [ ] confirm the key is stored only in an approved secret channel;
- [ ] confirm encrypted PostgreSQL auth rows are not treated as sufficient protection if the application key is exposed;
- [ ] verify no second runtime is concurrently using the same accepted session;
- [ ] define the revocation/re-pair procedure if custody is uncertain.

## 5. Secret inventory and rotation review

Use metadata only. **Never paste the secret value.**

For each live secret/credential, record:

```text
Logical secret ID/class:
Environment:
Owner/custodian:
Consumers:
Privilege/scope:
Storage/injection channel:
Last rotation date:
Maximum allowed age:
Next rotation deadline:
Revocation/rotation procedure reference:
Historical exposure suspected? yes/no
Action required:
Evidence:
```

Required classes include at minimum:

- runtime database credential;
- migrator database credential;
- WhatsApp application auth key;
- backup/storage credential;
- CI/CD or deployment integration credential where applicable;
- any third-party token introduced by the accepted release.

Canonical rotation policy expectations:

- Class A/B credentials: maximum 90 days unless the canonical policy explicitly records a stricter rule;
- Class C credentials: maximum 180 days unless stricter;
- suspected exposure: rotate/revoke immediately rather than waiting for the normal deadline;
- deleting a secret from current Git HEAD is **not** sufficient remediation for historical exposure.

Final PASS requires every live credential to be within policy or to have a documented immediate remediation completed before release acceptance.

## 6. Privacy and data-minimization review

- [ ] sample live/staging structured logs from accepted workflows and verify secret/PII redaction actually holds;
- [ ] verify logs/metrics/tickets do not expose unnecessary phone numbers, JIDs, external IDs or player-sensitive data;
- [ ] verify Player 360 sensitive identity access still requires the dedicated sensitive capability;
- [ ] verify ordinary admin/player support evidence can use redacted/safe references instead of raw identity data;
- [ ] verify UAT screenshots/evidence do not contain secret values;
- [ ] verify audit retention is purposeful and access-controlled rather than broadly shared;
- [ ] verify any exported backup or incident evidence follows the same minimization rule.

A leak discovered during sampling is a FAIL until contained and the affected credential/data path is remediated.

## 7. RPG administrative least-privilege review

Inventory every active AdminPrincipal relevant to the accepted environment:

```text
Principal reference:
Human/service owner:
Enabled? yes/no
Capabilities:
Scope type:
Subject scope if any:
GLOBAL truly required? yes/no
Reason for access:
Last used/reviewed:
Action: keep / narrow / disable / remove
Evidence:
```

Required checks:

- [ ] disabled principals cannot exercise authority;
- [ ] stale principals are disabled/removed;
- [ ] GLOBAL scope is exceptional and justified;
- [ ] subject-scoped roles remain subject-scoped where possible;
- [ ] sensitive Player 360 capability is not bundled into ordinary support access without need;
- [ ] Tier 4 approver authority exists only for principals that actually need it;
- [ ] Reception staff assignment is understood as routing, not authorization;
- [ ] WhatsApp group-admin status is understood as unrelated to RPG authority.

## 8. Final review matrix

Fill this table with evidence references rather than secret values.

| Area | Verdict | Evidence / action |
| --- | --- | --- |
| Current tracked-tree secret hygiene | PASS / FAIL / BLOCKED | |
| TLS strictness | PASS / FAIL / BLOCKED | |
| Logging/redaction | PASS / FAIL / BLOCKED | |
| Database runtime/migrator least privilege | PASS / FAIL / BLOCKED | |
| Admin authorization architecture | PASS / FAIL / BLOCKED | |
| Railway access/secret custody | PASS / FAIL / BLOCKED | |
| Supabase/PostgreSQL provider access | PASS / FAIL / BLOCKED | |
| GitHub collaborator/Actions/secrets access | PASS / FAIL / BLOCKED | |
| Historical secret-exposure review | PASS / FAIL / BLOCKED | |
| Backup storage access | PASS / FAIL / BLOCKED | |
| Google Drive sharing/privacy | PASS / FAIL / BLOCKED | |
| WhatsApp session/key custody | PASS / FAIL / BLOCKED | |
| Secret rotation deadlines | PASS / FAIL / BLOCKED | |
| Live/staging log privacy sample | PASS / FAIL / BLOCKED | |
| Active AdminPrincipal least privilege | PASS / FAIL / BLOCKED | |

## 9. Closure criteria for checklist 17.14

17.14 may be marked complete only when all of the following are true:

- repository-side current-tree review is recorded against an exact immutable SHA;
- all provider/account inventories in scope have been reviewed by an authorized human operator;
- stale/unnecessary access has been revoked or narrowed;
- live secret owners and rotation deadlines are known without copying secret values into evidence;
- any suspected historical exposure has been remediated by rotation/revocation;
- runtime/migrator database separation is verified in the actual accepted environment;
- WhatsApp session/application-key custody is understood and controlled;
- live/staging log sampling confirms the intended redaction boundary;
- active RPG AdminPrincipals have been reviewed for least privilege;
- no prohibited TLS bypass exists in the accepted runtime/configuration;
- zero open P0/P1 privacy, secret or access blocker remains;
- final evidence bundle is sufficient for another operator to audit the review.

If any required provider cannot be inspected, the result is **BLOCKED**, not PASS.

## 10. Relationship to other Phase 17 gates

- 17.13 production backup + alerts remains independently required;
- 17.14 is not closed by repository review alone;
- 17.15 release/tag/changelog should not be treated as final acceptance while 17.14 has an unresolved security blocker;
- 17.16 snapshot, 17.17 handoff, 17.18 monitoring and 17.20 final acceptance remain separate gates;
- 17.5, 17.7 and 17.10 still require their own external/human evidence;
- creating or merging this review changes **no release percentage by itself**; progress remains **98.00%** until a checklist gate actually closes.
