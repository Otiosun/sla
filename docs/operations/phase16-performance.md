# Phase 16 — performance evidence

This document maps checklist items 16.9–16.14 to permanent executable evidence.

## Permanent gate

`.github/workflows/performance-proof.yml` provisions PostgreSQL 18.6, applies the immutable migration chain, verifies the runtime schema and runs both permanent proofs:

- `db/proofs/phase16_performance_e2e.ts` with `--expose-gc`;
- `db/proofs/phase16_performance_coverage_e2e.ts`.

The second proof exists because the first implementation was deliberately re-audited against the exact canonical checklist wording before progress was credited. That audit found that Player360-only mixed load did not fully demonstrate "caminhos principais" and that item 16.10 explicitly names inventory, team, active encounter/battle and outbox. Progress must therefore depend on both proofs.

## 16.9 — realistic main-path load

The base proof seeds 1,500 real players and executes concurrent `PostgresPlayer360Repository` search/full reads. The canonical coverage proof then adds operational fixtures and executes 250 concurrent reads spanning:

- full Player360 reads;
- inventory balances;
- team roster;
- active encounter lookup;
- active battle lookup.

It additionally seeds and drains 1,000 real outbox messages through `PostgresMessagingRepository.claimOutbox` and `markOutboxSent`, requiring all 1,000 to reach `SENT` exactly once, zero pending/failed/sending residue, zero waiting pool work and no connection count above the configured maximum.

Measured elapsed time/throughput is emitted as evidence, not treated as a production SLO because GitHub Actions hardware is not production capacity.

## 16.10 — canonical critical-query benchmark

`phase16_performance_coverage_e2e.ts` runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against all six query families named by the canonical checklist, with real fixture cardinality:

1. Player360;
2. inventory;
3. team;
4. active encounter;
5. active battle;
6. outbox queue selection.

Every query must actually execute and expose a finite PostgreSQL `Execution Time`. The proof emits all six measured timings in one structured evidence record. No fixed millisecond threshold is used because runner timing variance would make such a gate flaky and would falsely imply a production SLO.

## 16.11 — EXPLAIN/ANALYZE and indexes oriented by real queries

The base proof executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over critical Player360 pagination and trainer-name prefix lookup shapes after seeding enough cardinality and running `ANALYZE`.

It requires:
- an actual execution plan;
- pagination to use `idx_players_status_created_id` or `idx_players_created_id`;
- trainer-name prefix lookup to use `idx_player_profiles_trainer_name_lower_pattern`.

The coverage proof extends EXPLAIN/ANALYZE evidence to the six canonical query families above. The gate therefore catches both missing real execution evidence and stable read-model index regressions where index use is intentionally asserted.

## 16.12 — N+1 review

`PostgresPlayer360Repository.searchPlayers` is instrumented through a counting Pool proxy without replacing PostgreSQL. The same real repository call is executed with a one-item page and a 50-item page.

The database query count must be identical for both result sizes and remain within a fixed four-query budget (BEGIN, page query, batched identity query, COMMIT). This proves identity enrichment remains batched instead of regressing to one query per player.

The full `getPlayer360` path loads Pokémon moves, persistent conditions, evolution flags, Pokédex, active encounter/battle, effects and activity using fixed bulk queries rather than per-row loops. Both performance proofs repeatedly exercise that path.

## 16.13 — pool saturation/backpressure

A real `pg.Pool` is created with `max: 2`. Two clients are held, a third acquisition is attempted, and the proof requires:
- `totalCount === 2` while saturated;
- the third request to remain unresolved;
- `waitingCount === 1`;
- no connection to be created above the configured maximum.

The queued acquisition must resume after one held client is released, after which the pool must drain to `waitingCount === 0`. The mixed operational load and outbox drain add higher-volume evidence that application work queues rather than escaping the configured connection ceiling.

## 16.14 — long-running soak / memory

The base proof runs 500 real Player360 searches in 25 batches against PostgreSQL. Node is launched with `--expose-gc`; heap usage is sampled after explicit GC before and after the soak.

Acceptance invariants:
- no failed query batch;
- pool connection count never exceeds 8;
- no queued DB work remains after completion;
- post-GC heap growth stays below a conservative 32 MiB ceiling.

This is a regression guard, not a production capacity claim. Production SLOs and incident thresholds belong to observability items 16.20–16.21.

## Scope and interpretation

These proofs demonstrate bounded behavior and guard against regressions in the current architecture. They do not claim GitHub Actions hardware represents production throughput, nor do measured operations/second become a production SLO. Correctness, exact outbox drain, real EXPLAIN execution, stable index use where asserted, bounded query count, pool ceilings/draining and memory-growth invariants are the pass/fail gates.
