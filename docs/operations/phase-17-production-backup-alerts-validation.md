# Phase 17 — Production Backup and Alerts Validation

Status: execution runbook for checklist item **17.13 — production backup + alerts**.

Creating or merging this file **does not close 17.13**. The repository already contains backup and alerting primitives, but the gate requires evidence from real external infrastructure: a successful production backup, independently verified stored artifacts, a disposable restore, and a real alert path that reaches an operator.

## 1. Baseline and known blocker

Repository baseline at preparation time:

- repository: `Otiosun/sla`;
- branch: `main`;
- Git SHA: `a7336cd53696bcf496ebcb45ddcb62e6366a6cdd`;
- tree: `c18f7f9f49b29cdfb417ead7e518236470ce179c`;
- release progress: **98.00%**;
- 17.13 remains open.

Observed scheduled backup failures already investigated:

| UTC date | Workflow run | Result | Root observable failure |
| --- | ---: | --- | --- |
| 2026-09-05 | `PostgreSQL Backup Automation` run #7, id `33953385616` | FAIL | `DATABASE_URL` reached the job empty; backup script failed closed |
| 2026-09-04 | `PostgreSQL Backup Automation` run #6, id `33851676661` | FAIL | same missing external configuration |

For both inspected runs:

- checkout succeeded;
- Docker/AWS CLI/shell preflight succeeded;
- the failure occurred in `Dump, checksum, upload and enforce retention`;
- `DATABASE_URL`, `BACKUP_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` were empty in the job environment;
- the script exited with `backup error: required environment variable is empty: DATABASE_URL`;
- no script defect was identified from these failures;
- no secret value was exposed in the logs.

Classification: **external backup configuration/secrets are absent, inaccessible to this workflow, or otherwise not provisioned for the scheduled job**. Do not weaken the fail-closed checks to make the workflow green.

## 2. Existing repository guarantees

### 2.1 Backup implementation

`scripts/operations/postgres-backup.sh` already enforces:

- PostgreSQL client image pinned to PostgreSQL 18.6 by immutable digest;
- required `DATABASE_URL`;
- required S3-compatible storage configuration;
- custom-format `pg_dump`;
- non-empty dump check;
- `pg_restore --list` structural validation before upload;
- SHA-256 checksum generation;
- JSON manifest generation;
- server-side AES256 encryption request on upload;
- controlled object prefix;
- positive retention-day validation;
- deletion only inside the controlled backup prefix;
- default retention of 30 days.

The scheduled workflow runs daily at **03:20 UTC** and also supports manual `workflow_dispatch`.

### 2.2 Alert model

`src/platform/metrics/alerts.ts` defines these baseline thresholds:

| Signal | WARNING | CRITICAL |
| --- | ---: | ---: |
| runtime p95 latency | 1,500 ms | 3,000 ms |
| runtime error ratio | 2% | 5% |
| messaging queue oldest item | 60 s | 300 s |
| database terminal error ratio | 1% | 2% |
| WhatsApp continuously disconnected | 60 s | 300 s |
| newest successful backup age | 26 h | 36 h |
| latest scheduled backup failed | — | immediate CRITICAL |

The repository intentionally remains monitoring-provider-neutral. `evaluateOperationalAlerts()` evaluates policy, but **a successful 17.13 requires an external monitoring/routing path to deliver a real alert to an operator**.

## 3. Safety invariants

Never satisfy this gate by:

- committing database/storage credentials to Git;
- writing live secrets to Drive, PR bodies, issues, screenshots or chat;
- replacing missing production secrets with staging/local credentials;
- using a production database login broader than necessary solely for convenience;
- disabling TLS verification;
- removing required-environment checks from the backup script;
- counting a CI disposable backup as production backup evidence;
- counting a returned `AlertSignal` object as proof that an operator received an alert;
- deleting failed workflow history to hide operational failures;
- restoring a proof backup over the live production database;
- weakening thresholds merely to suppress a failing alert.

## 4. External configuration inventory

Before re-running backup, record metadata only. Do not record values.

```text
Review date/time:
Operators:
Production database reference:
Production runtime DB credential owner:
Backup storage provider:
Backup bucket/container reference:
Backup prefix:
Backup credential owner:
Backup credential scope:
Region/endpoint model:
Secret injection layer:
Monitoring backend:
Alert delivery channel:
Primary on-duty recipient:
Secondary/escalation recipient:
Evidence bundle/reference:
```

The current workflow maps these GitHub Actions secret names into the backup process:

| Actions secret | Runtime environment variable | Required by script |
| --- | --- | --- |
| `PRODUCTION_DATABASE_URL` | `DATABASE_URL` | yes |
| `BACKUP_S3_BUCKET` | `BACKUP_S3_BUCKET` | yes |
| `BACKUP_AWS_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | yes |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | yes |
| `BACKUP_AWS_REGION` | `AWS_REGION` | yes |
| `BACKUP_AWS_SESSION_TOKEN` | `AWS_SESSION_TOKEN` | no |
| `BACKUP_S3_ENDPOINT_URL` | `AWS_ENDPOINT_URL` | no |

The workflow fixes:

- `BACKUP_S3_PREFIX=pokemon-rpg/postgres`;
- `BACKUP_RETENTION_DAYS=30`.

Important current behavior: the backup job does **not** declare a GitHub Environment. Therefore GitHub Environment-scoped secrets are not automatically available to this job merely because they exist in an Environment named `production`. The accepted custody design must choose one of these paths deliberately:

1. provide the required secrets through a repository/organization Actions secret scope that the current workflow can read; or
2. explicitly adopt a GitHub `production` Environment and update the workflow to declare that environment, with the resulting approval/protection semantics reviewed as a separate configuration change.

Do **not** add `environment: production` merely as a guess. First establish where the production backup secrets are intended to live and who owns that boundary.

## 5. Backup configuration review

1. Identify the actual production PostgreSQL source to be backed up.
   - Expected: it is the intended production database, not staging/local.
2. Identify the backup-only storage destination and controlled prefix.
   - Expected: staging and production do not share a backup prefix.
3. Review the database credential used by backup.
   - Expected: sufficient for logical backup, no unnecessary migration/superuser privileges.
4. Review storage credentials.
   - Expected: least privilege for required upload/list/retention deletion operations inside the intended bucket/prefix.
5. Verify credentials are injected through the accepted external secret layer under the exact names consumed by the workflow.
   - Expected: values remain outside Git and logs.
6. Verify production retention is **at least 30 days**. Any reduction below 30 days requires an explicit canonical policy change; it must not be done merely to simplify storage management.
7. Verify storage access is reviewed under Phase 17.14.
8. Verify object encryption/storage-policy expectations are compatible with the script's `--sse AES256` upload contract.
9. If an S3-compatible endpoint is used, verify `BACKUP_S3_ENDPOINT_URL` / `AWS_ENDPOINT_URL` and region behavior against that provider without disabling TLS validation.

If any required input is unavailable or custody is unknown, result: **BLOCKED**.

## 6. Real backup execution

After configuration is in place, execute the canonical workflow rather than reproducing the commands manually as the primary proof.

10. Trigger `workflow_dispatch` or wait for a scheduled `PostgreSQL Backup Automation` execution against the accepted production source/storage configuration.
11. Confirm the job receives non-empty required configuration without printing secret values.
12. Confirm `pg_dump` completes.
13. Confirm the dump is structurally validated by `pg_restore --list` before upload.
14. Confirm workflow result is SUCCESS.
15. Record exact workflow run ID, commit SHA and UTC completion time.
16. Confirm the output reports a backup name matching the canonical shape:

```text
postgres-<UTC timestamp>-<git sha>.dump
```

17. Verify the source SHA in the manifest is the workflow checkout SHA or another deliberately documented value permitted by the script contract.

Do not close 17.13 after workflow SUCCESS alone. Storage and restore must still be independently verified.

## 7. Stored artifact verification

For the successful run, verify the storage destination contains the expected triplet:

- `<backup>.dump`;
- `<backup>.dump.sha256`;
- `<backup>.dump.json`.

18. Verify all three objects exist under the intended production prefix.
19. Verify the dump object is non-empty.
20. Verify manifest metadata contains the expected creation time, Git SHA, PostgreSQL image reference, retention and dump name.
21. Download or otherwise independently inspect the checksum and dump through an authorized operator path.
22. Recompute SHA-256 and compare to the stored checksum.
   - Expected: exact match.
23. Confirm storage-side metadata/policy indicates the accepted encryption and access controls.
24. Confirm the backup prefix cannot accidentally target staging or another project.
25. Confirm no credential appears in object names or manifest content.

Evidence should reference object names/metadata and checksum result, never storage secret values.

## 8. Disposable restore proof

A production backup is not accepted until it can actually be restored.

26. Create or select a disposable PostgreSQL 18.6-compatible restore target isolated from production.
27. Confirm the restore target contains no valuable state.
28. Fetch the exact production backup artifact selected above.
29. Verify SHA-256 before restore.
30. Restore using the canonical logical restore procedure in `docs/operations/backup-restore.md`.
31. Run the canonical schema/runtime verification against the restored database where applicable.
32. Cross-check representative durable domains, at minimum:
   - player/profile or onboarding state;
   - economy/inventory state;
   - Pokémon state;
   - one administrative/audit table;
   - one outbox/operational durable table where applicable.
33. Record approximate restore duration and any manual steps required.
34. Destroy the disposable restore target after evidence is captured, unless retained temporarily under an explicit test-data policy.

PASS requires successful restore from the **same real stored production artifact** verified in section 7. CI restore proof alone is not sufficient.

## 9. Retention proof

35. Confirm configured production retention is at least 30 days.
36. Confirm object listing can determine expired objects under the controlled prefix.
37. Verify the retention path refuses to delete outside the configured prefix.
38. Prefer non-destructive provider-side evidence of retention configuration/history when the environment is too new to contain 30-day-old objects.
39. Do not fabricate an old production backup merely to prove deletion.
40. If a disposable S3-compatible test prefix is available, retention deletion behavior may be separately exercised there as supporting evidence, but it does not replace proof that production retention configuration is correct.

## 10. Monitoring backend configuration

The code is provider-neutral. Before alert testing, select/configure the actual monitoring backend and delivery channel used for production operations.

Record:

```text
Monitoring backend:
Metric/log ingestion source:
Backup-health ingestion source:
Alert rule owner:
WARNING destination:
CRITICAL destination:
On-duty recipient:
Escalation recipient:
Acknowledgement mechanism:
Incident linkage mechanism:
```

41. Verify runtime/application metrics reach the backend.
42. Verify messaging queue health data required by the alert policy reaches the backend.
43. Verify database error/latency health reaches the backend.
44. Verify WhatsApp connectivity health reaches the backend.
45. Verify backup health is derived from:
   - newest successful stored backup age; and
   - latest scheduled workflow result.
46. Confirm metric labels/log forwarding preserve the repository's PII/secret minimization contract.

If there is no actual backend or delivery channel, 17.13 is **BLOCKED**.

## 11. Backup failure CRITICAL delivery test

The observed failed scheduled backup is a real operational condition matching the policy: a latest scheduled backup failure must be CRITICAL while it remains the current state.

47. Configure the monitoring backend to observe the latest scheduled backup result.
48. Confirm the current/latest failure condition produces a CRITICAL without lowering/rewriting the canonical policy.
49. Confirm a real notification is delivered to the intended operator/channel.
50. Record delivery timestamp and alert reference.
51. Confirm the alert contains enough non-secret context to identify:
   - backup failure;
   - environment;
   - approximate time;
   - workflow/run reference or equivalent investigation pointer.
52. Confirm the alert does **not** expose database/storage credentials.
53. Have the receiving operator acknowledge the alert through the intended operational process.
54. Link or create an incident/evidence record according to `docs/operations/incident-response.md`.

A dashboard turning red without a delivered/acknowledged notification is not enough.

## 12. Backup recovery alert clear/recovery test

After backup configuration is corrected and a real backup succeeds:

55. Confirm the backend observes the successful scheduled/manual canonical workflow result.
56. Confirm newest successful backup age resets to a healthy value.
57. Confirm the previous backup-failure condition resolves according to the monitoring backend's rule model.
58. Confirm the operator can distinguish `resolved` from `silenced`/`disabled`.
59. Record recovery evidence.

Do not delete the original failure evidence when the condition recovers.

## 13. Threshold delivery spot-checks

At least one non-backup WARNING/CRITICAL path should be proven end-to-end without deliberately damaging production.

Preferred approaches:

- provider/backend test notification using the exact production routing rule;
- controlled staging signal wired through the same delivery channel;
- monitoring-rule test mode if it proves the same receiver/escalation chain.

60. Prove one WARNING reaches the intended channel/operator.
61. Prove one CRITICAL reaches the intended channel/operator.
62. Verify severity is preserved in delivery.
63. Verify acknowledgement/escalation behavior is understood.
64. Verify no PII/secret leakage appears in the notification.

Do not force a real production WhatsApp outage, database fault or queue backlog solely to satisfy this runbook.

## 14. Evidence template

For every executed validation step:

```text
Step:
UTC date/time:
Operator:
Environment:
Expected:
Actual:
Verdict: PASS | FAIL | BLOCKED
Evidence: workflow/object/checksum/restore/alert/incident reference
Issue/action required:
```

Final summary:

```text
Git SHA:
Production DB reference:
Backup workflow run:
Backup completion UTC:
Stored dump reference:
Checksum verified: yes/no
Manifest verified: yes/no
Disposable restore: PASS/FAIL/BLOCKED
Retention: PASS/FAIL/BLOCKED
Monitoring backend:
Backup failure CRITICAL delivered: yes/no
Backup recovery observed: yes/no
WARNING delivery spot-check: PASS/FAIL/BLOCKED
CRITICAL delivery spot-check: PASS/FAIL/BLOCKED
Open P0 blockers:
Open P1 blockers:
Overall verdict: PASS | FAIL | BLOCKED
Operator sign-off:
Evidence bundle/reference:
```

## 15. Closure criteria for checklist 17.13

17.13 may be marked complete only when all of the following are true:

- accepted production backup configuration is externally provisioned without secrets entering Git/Drive/logs;
- a canonical `PostgreSQL Backup Automation` run succeeds against the accepted production source/storage;
- dump, SHA-256 checksum and manifest are verified in the real storage destination;
- checksum is independently recomputed and matches;
- the exact stored production artifact is restored successfully into a disposable PostgreSQL target;
- representative durable state is verified after restore;
- production retention configuration satisfies the canonical minimum of 30 days;
- a real monitoring backend is connected;
- latest scheduled backup failure is interpreted as immediate CRITICAL;
- a real CRITICAL notification reaches and is acknowledged by an intended operator;
- successful backup recovery is observed without deleting failure evidence;
- at least one additional WARNING/CRITICAL routing path is proven without intentionally harming production;
- alerts/evidence contain no unnecessary secrets or player PII;
- zero open P0/P1 durability/alerting blocker remains.

Until all criteria pass, **17.13 remains open and progress remains 98.00%**.

## 16. Current expected next action

The repository does **not** currently need a code workaround for the observed backup failure. The next operational action is to provision/confirm the external production backup configuration under the exact secret names consumed by the workflow and select/configure the monitoring receiver, then run this validation.

If subsequent evidence shows that correctly provisioned secrets still do not reach the workflow, that becomes a separate workflow-scoping/configuration defect. Diagnose that specific failure before modifying `backup-automation.yml`.
