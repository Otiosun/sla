# Phase 16 slice 1 — authorization and log redaction review

## Scope

This review maps existing permanent controls to Phase 16 items 16.5, 16.6, 16.16 and 16.19. It does not claim completion of the broader admin panel/API security review in 16.29.

## 16.5 — crash after commit and before send

Permanent messaging evidence already proves the mechanical owner can commit before an artificial process failure and that replay/restart converges without applying the mechanical mutation twice.

Primary evidence:

- `db/proofs/phase13_messaging_foundation_e2e.ts`
  - simulates a crash after the Economy owner commit;
  - restarts `MessagingService` with a fresh repository/service instance;
  - replays the same message;
  - verifies wallet/ledger totals remain exactly-once.
- the same proof separately verifies an Outbox delivery failure does not repeat mechanical state.

## 16.6 — restart during encounter, battle and outbox

Permanent evidence covers all three required persistence boundaries:

- Encounter: `tests/db/encounter.integration.test.ts` recreates the Encounter service across a logical restart and requires the same encounter id, snapshot, RNG counter and expiry with one persisted encounter/snapshot.
- Battle: `db/proofs/phase9_battle_e2e.ts` creates a fresh `BattleService`/repository after resolved concurrent state and requires the exact persisted winning snapshot to be recovered.
- Outbox: `db/proofs/phase13_messaging_foundation_e2e.ts` recovers stale `SENDING`, retries failed delivery, dead-letters at the configured limit, and proves delivery failure does not replay mechanical state.

## 16.16 — object/function/property authorization review

The Admin Registry is the only administrative mutation surface; operations are defined centrally and require declared capability, target, authorization mode and strict input schema.

Reviewed controls and permanent evidence:

- **Function-level authorization:** `db/proofs/phase12_admin_registry_e2e.ts` proves a principal without `admin.role.assign` cannot prepare the operation.
- **Object-level authorization / BOLA:** the same proof gives SUPPORT scope to one Player and verifies reading another Player fails with `ADMIN_AUTHORIZATION_DENIED`.
- **Property-level authorization / mass assignment:** strict Zod schemas reject undeclared fields; the registry proof sends an extra `status` field to `player.read` and requires `ADMIN_INVALID_INPUT`.
- **Sensitive properties:** Player 360 separates `player.read` from `player.read_sensitive`; identities/profile metadata are redacted without the sensitive capability.
- **Collection enumeration/BFLA:** Player 360 collection search requires GLOBAL authorization instead of allowing subject scope to enumerate unrelated players.
- **High-risk global operations:** catalog publish and role assignment use GLOBAL_ONLY authorization; R4 paths additionally require simulation/confirmation/independent approval according to policy.
- **Concurrent overwrite defense:** mutable admin owners use expected revision/version and fail closed on stale CAS; Phase 16 adds an explicit two-admin simultaneous release race proof in `db/proofs/phase16_admin_concurrency_e2e.ts`.

Review result: no generic PATCH/SQL admin escape hatch or known object/function/property authorization bypass is accepted by the reviewed server-side surfaces.

## 16.19 — log redaction review

Production structured logging passes context through `src/platform/logging/index.ts` before writing. Sensitive-key redaction includes API key, authorization, cookie, JID, password, phone/phone number, seed, secret and token. String redaction also removes Bearer values and phone-like digit sequences.

Permanent evidence:

- `tests/shared-kernel/clock-rng-logging.test.ts` explicitly injects JID, token, seed and a phone-like value and requires redacted output.
- `.github/workflows/ci.yml` now rejects direct `console.*` or direct `process.stdout/process.stderr.write` usage anywhere under production `src/`, except the single structured logging sink itself.

This means production code cannot bypass the redacting logger with an ad-hoc console write without failing CI.

## Boundaries not claimed by this review

This slice does not claim dependency audit/update policy, secret rotation, metrics/alerts, automated backup retention, disaster recovery, load testing, pool saturation, memory leak testing, or the final admin panel/API security review. Those remain their own Phase 16 checklist items.
