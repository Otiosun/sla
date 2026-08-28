# Phase 16 — concurrency and fault-injection evidence

Canonical scope of this slice: checklist items 16.1, 16.2, 16.4 and 16.7.

## 16.1 — duplicate-message storm

Permanent proof: `db/proofs/phase16_messaging_concurrency_faults_e2e.ts`, executed by `WhatsApp Proof`.

The proof delivers the same normalized external message 48 times concurrently through `MessagingService.receive()`. The expected invariant is one processing owner, with all other deliveries converging to `IN_FLIGHT` or `REPLAYED`. It then requires a stable replay after completion and verifies in PostgreSQL that there is exactly one Inbox row, one wallet mutation, one Outbox row and one rate-limit admission for the external message.

This is stronger than a sequential duplicate retry: the unique Inbox claim, active lease and owner idempotency are exercised while requests race.

## 16.2 — simultaneous commands from the same player

Permanent proof: `db/proofs/phase16_messaging_concurrency_faults_e2e.ts`, executed by `WhatsApp Proof`.

The proof sends 24 distinct command messages concurrently from the same registered player. Every command traverses Inbox claim, player/chat rate-limit admission, routing and `EconomyService` wallet mutation. The final database state must contain exactly 24 Inbox rows, 24 wallet ledgers and a balance delta of exactly 24: no lost update and no duplicate application.

The test does not invent a global per-player mutex. Independent commands are allowed to run concurrently; correctness comes from the existing transactional/idempotent owners and database invariants.

## 16.4 — crash before commit

Permanent proof: `db/proofs/phase16_messaging_concurrency_faults_e2e.ts`, executed by `WhatsApp Proof`.

Inside a real `withTransaction()` boundary, the proof mutates a wallet balance and throws before COMMIT. PostgreSQL must roll the mutation back completely. The Inbox attempt fails safely, a fresh service instance retries the same message, the transaction then commits once, and a later delivery is replay-only.

Rate-limit admission is intentionally outside the mechanical transaction and is already durable/idempotent by Inbox charge. The invariant under test is that no partial mechanical state survives a pre-COMMIT process failure.

## 16.7 — fault injection matrix

All required fault classes are covered by permanent workflows:

| Fault | Permanent evidence | Expected safe behavior |
| --- | --- | --- |
| PostgreSQL timeout | `db/proofs/phase16_messaging_concurrency_faults_e2e.ts` → `WhatsApp Proof` | real `statement_timeout` produces SQLSTATE `57014`; transaction rolls back completely |
| PostgreSQL deadlock | `db/proofs/phase16_postgres_retry_e2e.ts` → permanent CI/Admin proof path | real `40P01`; only safe retry boundary retries and converges |
| Provider failure | `db/proofs/phase13_messaging_foundation_e2e.ts` → `WhatsApp Proof` | failed outbound delivery never repeats mechanics; retry/dead-letter state is durable |
| Narrative AI timeout | `tests/narrative/narrative-n0.test.ts` → `Narrative Proof` | timeout becomes deterministic `TIMEOUT` fallback; AI keeps zero mechanical authority |

A timeout/deadlock/provider/AI failure is not considered covered because the code appears to handle it. The cases above are executable evidence under permanent GitHub Actions workflows.

## Promotion rule

These checklist items receive canonical credit only after the exact WIP tree passes every applicable permanent workflow, an exact one-commit clean candidate reproduces that tree, the clean candidate also passes every permanent workflow, and the merged `main` SHA passes the complete post-merge push suite.
