# Phase 16 — performance evidence

This document maps checklist items 16.9–16.14 to permanent executable evidence.

## Permanent gate

`.github/workflows/performance-proof.yml` provisions PostgreSQL 18.6, applies the immutable migration chain, verifies the runtime schema and runs `db/proofs/phase16_performance_e2e.ts` with `--expose-gc`.

## 16.9 — realistic load test

The proof seeds 1,500 real players and trainer progression records, then executes 120 concurrent mixed Player360 operations through `PostgresPlayer360Repository`: paginated search plus full `getPlayer360` reads. Every operation must settle successfully, throughput is measured, the pool must drain and connection count may never exceed the configured maximum.

This is deliberately a repository/service-boundary workload instead of a raw-SQL-only benchmark: it exercises the same transaction helper and Player360 SQL composition used by the application.

## 16.10 — critical queries with EXPLAIN ANALYZE

The proof executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over critical Player360 pagination and trainer-name prefix lookup shapes after seeding enough cardinality and running `ANALYZE`.

It requires:
- an actual execution plan (`Actual Total Time` present);
- pagination to use `idx_players_status_created_id` or `idx_players_created_id`;
- trainer-name prefix lookup to use `idx_player_profiles_trainer_name_lower_pattern`.

The gate therefore fails if a future change silently drops or bypasses the intended read-model indexes under the proof workload.

## 16.11 — N+1 review

`PostgresPlayer360Repository.searchPlayers` is instrumented through a counting Pool proxy without replacing PostgreSQL. The same real repository call is executed with a one-item page and a 50-item page.

The database query count must be identical for both result sizes and remain within a fixed four-query budget (BEGIN, page query, batched identity query, COMMIT). This proves the identity enrichment remains batched and does not regress to one query per player.

The full `getPlayer360` path likewise already loads Pokémon moves, persistent conditions, evolution flags, Pokédex, active encounter/battle, effects and activity in fixed bulk queries rather than per-row loops; the mixed-load portion exercises that path repeatedly.

## 16.12 — pool saturation

A real `pg.Pool` is created with `max: 2`. Two clients are held, a third acquisition is attempted, and the proof requires:
- `totalCount === 2` while saturated;
- the third request to remain unresolved;
- `waitingCount === 1`;
- no connection to be created above the configured maximum.

## 16.13 — backpressure under load

The queued third pool acquisition from 16.12 is the backpressure proof. It must resume after one held client is released, then the pool must drain to `waitingCount === 0` without exceeding `max: 2`.

The 120-operation mixed load and the soak phase add higher-volume evidence that the main pool queues work rather than escaping its configured connection ceiling.

## 16.14 — long-running soak / memory

The proof runs 500 real Player360 searches in 25 batches against PostgreSQL. Node is launched with `--expose-gc`; heap usage is sampled after explicit GC before and after the soak.

Acceptance invariants:
- no failed query batch;
- pool connection count never exceeds 8;
- no queued DB work remains after completion;
- post-GC heap growth stays below a conservative 32 MiB ceiling.

This is a regression guard, not a production capacity claim. Production SLOs and incident thresholds belong to observability items 16.15–16.22.

## Scope and interpretation

These proofs demonstrate bounded behavior and guard against regressions in the current architecture. They do not claim GitHub Actions hardware represents production throughput, nor do measured operations/second become a production SLO. Performance numbers are emitted as evidence; correctness, index use, bounded query count, pool ceilings, draining and memory-growth invariants are the pass/fail gates.
