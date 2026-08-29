# Operational observability and alerting

## Scope

Phase 16 requires operational visibility for latency, errors, messaging queue behavior, PostgreSQL, WhatsApp, and backup health. The implementation is provider-neutral: application boundaries emit typed metrics through `MetricSink`, while deployment may route JSON-line metrics to the selected monitoring backend without changing game mechanics.

Metrics are operational evidence only. They never grant mechanical authority, alter battle/economy outcomes, or carry player content.

## Mandatory metric families

### Runtime/application

- `runtime.operation.duration_ms` — end-to-end duration of an observed application operation.
- `runtime.operation.errors_total` — returned or thrown application failures.

Recommended bounded labels: `operation`, `result`. Never label with player IDs, JIDs, phone numbers, message text, idempotency keys, database URLs, tokens, or arbitrary exception strings.

### Messaging queue

- `messaging.queue.claimed` — claimed batch size gauge per worker run.
- `messaging.queue.sent_total` — successfully completed queue items.
- `messaging.queue.failed_total` — failed items/runner failures.
- `messaging.queue.run_duration_ms` — worker-run duration.

The queue monitoring backend should additionally derive oldest pending item age from durable Outbox/Media timestamps when production dashboards are connected. Alert policy is expressed in terms of oldest pending age because batch size alone is not backlog health.

### PostgreSQL

- `db.transaction.duration_ms` — transaction/retry boundary latency.
- `db.transaction.attempts` — attempts consumed by a transaction execution.
- `db.transaction.retries_total` — retries caused by retryable PostgreSQL transaction failures.
- `db.transaction.errors_total` — terminal transaction failures with bounded `sqlstate` and retry-safety class labels.

No query text, parameters, connection strings, or idempotency keys are emitted.

### WhatsApp provider

- `whatsapp.connection.open_total`
- `whatsapp.connection.close_total`
- `whatsapp.connection.logged_out_total`
- `whatsapp.reconnect.scheduled_total`
- `whatsapp.incoming.total`
- `whatsapp.incoming.errors_total`
- `whatsapp.outgoing.total`
- `whatsapp.outgoing.errors_total`
- `whatsapp.outgoing.duration_ms`

These signals describe provider health without exposing message bodies or opaque WhatsApp identities.

### Backup

Backup automation emits its final success/failure through the workflow result. Monitoring must derive `backupAgeMs` from the newest successful backup manifest/object and `backupLastRunSucceeded` from the latest scheduled run. Backup failure is critical independently of artifact age.

## Baseline thresholds

The code-level source of truth is `DEFAULT_ALERT_THRESHOLDS` in `src/platform/metrics/alerts.ts`. These are initial production baselines and must be tuned from real traffic after launch; weakening them requires an explicit operational review.

| Signal | WARNING | CRITICAL |
| --- | ---: | ---: |
| runtime p95 latency | >= 1,500 ms | >= 3,000 ms |
| runtime error ratio | >= 2% | >= 5% |
| oldest queue item age | >= 60 s | >= 300 s |
| database terminal error ratio | >= 1% | >= 2% |
| WhatsApp continuously disconnected | >= 60 s | >= 300 s |
| age of newest successful backup | >= 26 h | >= 36 h |
| latest scheduled backup failed | — | immediately CRITICAL |

`evaluateOperationalAlerts()` validates snapshots and fails closed on malformed negative values or ratios outside 0..1 rather than silently normalizing corrupt telemetry.

## Routing and response

### WARNING

WARNING means service degradation or approaching an SLO boundary. The on-duty operator should inspect the correlated logs/metrics and determine whether the condition is transient, traffic-driven, provider-driven, or caused by a deployment. Repeated warnings in the same hour are escalated as an incident candidate.

### CRITICAL

CRITICAL means durability, provider availability, or application health may be materially compromised. Create/attach an incident, preserve correlation evidence, and follow `docs/operations/incident-response.md`. Do not "fix" critical telemetry by deleting evidence or widening thresholds during an active incident.

## Correlation

Structured application logs remain the source for causality/correlation IDs. Metrics intentionally avoid high-cardinality correlation IDs. Investigation starts from the metric time window and bounded operation/provider labels, then pivots into structured logs for individual correlation/causation chains.

## Data safety

Metric labels are an allowlisted operational surface. Secret values, PII, Pokémon/player free-form narrative, raw SQL, database URLs, WhatsApp JIDs/phone numbers, auth state, QR data, and provider exception payloads are forbidden.

## Proof

Permanent CI exercises:

- metric sink validation and JSON-line export semantics;
- runtime and queue instrumentation decorators;
- alert threshold warning/critical behavior and malformed-input rejection;
- PostgreSQL retry instrumentation through type/unit/integration coverage;
- WhatsApp provider instrumentation through adapter tests/typecheck;
- backup automation through the Security Integrity Proof.

The metrics layer has no dependency on a specific SaaS monitoring provider.