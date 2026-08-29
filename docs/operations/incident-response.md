# Incident response and correlation trace

Use this procedure for suspected corruption, duplicate economic effects, authorization bypass, stuck messaging, battle/encounter divergence or other critical runtime failure.

## 1. Detect and classify

Record:

- UTC start time and first observed symptom;
- affected player/chat/admin operation when known;
- user-facing support/correlation code;
- suspected subsystem: messaging, economy, encounter, battle, admin, database or provider;
- severity and whether new mutations should be isolated.

Do not delete or rewrite evidence while diagnosing.

## 2. Contain

If continued writes can amplify damage, isolate the affected runtime/process or traffic path using deployment controls. Preserve PostgreSQL and application evidence before attempting repair. Do not improvise destructive SQL as containment.

## 3. Trace by correlation and causation

Start from the known `correlation_id` or administrative operation ID and reconstruct the chain across the relevant durable evidence:

- `admin_operations.correlation_id`;
- `audit_events.correlation_id` and `causation_id`;
- `inventory_ledger.correlation_id` / `wallet_ledger.correlation_id`;
- `battle_events.correlation_id` / `causation_id`;
- messaging inbox/outbox evidence and external-message idempotency when the incident originated in WhatsApp.

For administrative mutations, compare the request fingerprint, actor, reason, confirmations/approvals, before/after changes and owner ledger evidence. A missing completion record does not imply the owner failed: inspect owner evidence before retrying.

The permanent `phase12_admin_audit_reconstruction_e2e.ts` proof demonstrates the critical crash window in which the owner committed first and the administrative completion recovered later without duplicating the mutation.

## 4. Establish mechanical truth

Before repair, determine:

- whether the idempotency key already committed;
- whether duplicate ledger rows exist;
- the latest valid revision/version for the affected aggregate;
- whether outbox delivery failed independently of committed mechanics;
- whether a stale/reordered command was correctly rejected;
- whether a backup/restore point predates the corruption if database recovery is required.

## 5. Recover

Prefer deterministic recovery in this order:

1. replay an existing idempotent operation when evidence proves it already committed;
2. use the registered administrative compensation path when a compensating operation exists;
3. use the Disaster Recovery restore procedure for database-level corruption;
4. perform a new corrective mutation only through an authorized owner/admin operation with a new reason and correlation ID.

Never edit append-only audit or economic ledger history to make current state look correct.

## 6. Verify

After recovery:

- rerun affected domain invariants;
- verify wallet/inventory/roster/battle/encounter state against the reconstructed trail;
- verify inbox/outbox convergence when messaging was involved;
- confirm no second economic or capture effect was created;
- run the relevant permanent proof(s) before restoring normal traffic.

## 7. Close and learn

Record root cause, timeline, affected IDs, correlation chain, recovery action, proof results and preventive change. Any new invariant discovered during the incident should become a permanent automated proof before the incident is considered fully closed.
