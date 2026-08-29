# Audit integrity and retention policy

The audit trail is operational evidence and must not be treated as disposable application data.

## Protected evidence

The current evidence set includes, when applicable:

- `audit_events`;
- `admin_operation_changes`;
- admin operation confirmations and approvals;
- inventory and wallet ledgers carrying actor/reason/correlation metadata;
- battle events and snapshots;
- encounter snapshots;
- starter grants and progression ledgers.

The runtime database role is intentionally denied UPDATE, DELETE and TRUNCATE on append-only audit/ledger/snapshot tables by the permanent CI privilege-separation proof. Application code may append evidence, but it cannot silently rewrite or remove it.

## Retention

Current policy is **indefinite retention**. There is no automated purge job and no runtime path that deletes audit evidence.

This is deliberate until an external archival tier and its restore verification are implemented. A future retention reduction must not silently replace this policy.

## Future archival requirements

Before any historical audit data may leave the primary database:

1. copy the selected range to a durable archive;
2. record row counts, time range and content/checksum evidence;
3. restore a sample/archive copy and prove that the correlation/causation chain remains reconstructable;
4. obtain an explicit maintenance approval;
5. prune only through a privileged maintenance procedure, never the runtime role;
6. record the archival/prune operation itself in the operational change log.

A failed or unverifiable archive means no prune occurs.

## Incident preservation

When an incident is open, relevant audit, ledger, inbox/outbox, encounter and battle evidence is placed under preservation by procedure: no archival/prune operation may target the incident time window until the incident owner closes the preservation requirement.
