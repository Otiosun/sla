# Phase 17 — Player 360 and Risk Operations Human UAT Runbook

Status: execution runbook for checklist item **17.10 — UAT do Player 360 e operações de risco**.

This document prepares the human UAT. Its existence or merge **does not close 17.10**. The checklist item may only be marked complete after the accepted target is exercised by human operators, the required evidence is recorded, and the final verdict is PASS with no open P0/P1 blocker.

The Registry and persisted authorization/audit state are authoritative. The capability catalog is not proof that an operation is currently registered. Do not invent or exercise operations that are not present in the runtime Registry.

## 1. Preconditions

Record and verify all of the following before starting:

- [ ] exact immutable Git SHA under test;
- [ ] target environment recorded and approved for UAT;
- [ ] deployed/runtime revision matches the intended SHA/artifact;
- [ ] database migrations/schema verification passed;
- [ ] active content release and ruleset identifiers recorded;
- [ ] Admin Registry seed/reconciliation completed without drift;
- [ ] at least one disposable player with representative inventory/wallet/Pokémon state exists;
- [ ] one ordinary/limited admin principal exists for denial and least-privilege checks;
- [ ] one authorized Tier 3 principal exists for representative R3 operations;
- [ ] two distinct authorized principals exist for the Tier 4 dual-control slice: proposer and approver;
- [ ] the Tier 4 target is disposable and reverting/cleanup is understood before any apply;
- [ ] screenshots/logs are configured so identity data, secrets and auth material are not exposed;
- [ ] operators have read the canonical `docs/operations/admin-operator-manual.md`;
- [ ] raw SQL is not being used as the administrative interface.

Stop and mark the UAT BLOCKED if any safety precondition cannot be established.

## 2. Canonical policy facts under test

The current Registry model uses risk tiers 0 through 4, but **risk tier alone does not determine the gates**. Every operation must obey its registered/persisted policy snapshot:

- `requiresReason`;
- `requiresExpectedRevision`;
- `requiresSimulation`;
- `requiresConfirmation`;
- `requiredApprovals`.

Representative operations used by this UAT:

| Slice | Operation | Risk | Registered policy to prove |
| --- | --- | ---: | --- |
| Player 360 read | `player.read` / `player.search` | 0 | capability + scope; no mutation gates |
| Player 360 sensitive | `player.read_sensitive` / `player.search_sensitive` | 0 | dedicated sensitive capability; correct subject/global scope |
| Low-risk revisioned mutation | `pokemon.roster.move` | 1 | reason + expected revision; no confirmation/approval |
| Medium-risk economic mutation | `wallet.adjust` | 2 | reason; no expected revision/confirmation/approval |
| High-risk mutation | `battle.force_cancel` | 3 | reason + expected revision + confirmation |
| Batch guard | `batch.execute.low_risk` | 3 | reason + expected revision + confirmation |
| Critical dual-control mutation | `admin.role.assign` | 4 | GLOBAL_ONLY + reason + expected revision + simulation + confirmation + 1 independent approval |
| Critical content mutation | `content.release.publish` | 4 | GLOBAL_ONLY + reason + expected revision + simulation + confirmation + 1 independent approval |

`batch.execute.high_risk` is intentionally not registered in the current implementation. The UAT must verify that this cannot be used as an authorization bypass for high-risk child operations.

The R4 success path needs to be executed for **at least one** registered Tier 4 operation on disposable UAT state. The second R4 operation may be exercised only through its non-destructive gates when applying it would create unnecessary release/security risk.

## 3. Player 360 — ordinary read path

For each numbered step, record expected result, actual result, PASS/FAIL and evidence reference.

1. Use an authorized principal with ordinary `player.read` access to search for a disposable player.
   - Expected: the player is found without exposing sensitive identity details not authorized by the ordinary read.
2. Open the player's Player 360 view with `includeSensitive=false`.
   - Expected: the read returns the canonical cross-domain view available in the current implementation: player/profile, onboarding, progression, location, wallet, inventory, Pokémon, Pokédex, active encounter/battle, effects and recent activity where data exists.
3. Compare at least three Player 360 sections with their authoritative underlying state.
   - Required minimum: one economy/inventory section, one Pokémon section, and one world/battle/onboarding section.
   - Expected: values agree; Player 360 is not a stale parallel source of truth.
4. Verify unsupported coverage is explicit.
   - Expected: currently unsupported sections are represented honestly rather than silently fabricated as complete. The current contract declares `COOLDOWNS` and `PUNISHMENTS_FLAGS` as unsupported.
5. Search with a stable cursor when more than one page is available, or use a prepared multi-result UAT dataset.
   - Expected: pagination is stable and the cursor is opaque to the operator.
6. Supply a malformed cursor.
   - Expected: fail-closed input error; no raw SQL controls or stack-sensitive internals exposed.

## 4. Player 360 — sensitive-data boundary

7. Attempt `includeSensitive=true` using a principal that has ordinary `player.read` but lacks `player.read_sensitive`.
   - Expected: denied; ordinary Player 360 access does not imply permission to view sensitive identities.
8. Repeat with a principal that has the dedicated sensitive capability and correct subject scope.
   - Expected: sensitive view succeeds only for the authorized subject.
9. Attempt a sensitive global search with a principal that has the capability but lacks GLOBAL scope.
   - Expected: denied because `player.search_sensitive` is GLOBAL_ONLY.
10. Use a correctly authorized global principal for a sensitive search.
    - Expected: search succeeds under the dedicated sensitive capability.
11. Attempt external-identity lookup with only `identityProvider` or only `externalId`.
    - Expected: input rejected; both fields are required together.
12. Attempt external-identity lookup with `includeSensitive=false`.
    - Expected: input rejected; external identity lookup requires sensitive mode.
13. Review logs/screenshots/evidence from the sensitive slice.
    - Expected: evidence proves authorization behavior without publishing unnecessary personal identifiers or credentials.

## 5. Capability and scope denial checks

14. Attempt a subject mutation using a principal without the operation's required capability.
    - Expected: `AUTHORIZATION_DENIED`; no operation is applied.
15. Attempt a subject mutation using the correct capability but a scope that does not cover the target player.
    - Expected: denied; capability and scope are both required.
16. Attempt a GLOBAL_ONLY operation using a non-global principal.
    - Expected: denied even if the capability key is otherwise present.
17. Disable or use a disabled admin principal and attempt a governed read/mutation.
    - Expected: denied; disabled principal authority is not honored.
18. Verify WhatsApp group-admin status alone does not authorize any of the governed admin operations.
    - Expected: no RPG authority without active AdminPrincipal + capability + scope.

## 6. R1 representative mutation — expected revision without confirmation

Use `pokemon.roster.move` against disposable UAT state.

19. Prepare without `reason`.
    - Expected: rejected because the operation requires a reason.
20. Prepare without `expectedRevision`.
    - Expected: rejected because the operation requires the current expected revision.
21. Prepare correctly with reason, current revision, unique idempotency key and correlation id.
    - Expected: operation reaches its registered ready state without an invented confirmation/approval gate.
22. Apply.
    - Expected: the roster mutation occurs exactly once through the registered domain service.
23. Re-read Player 360.
    - Expected: roster placement reflects the new state.
24. Re-apply the already APPLIED operation.
    - Expected: convergence/idempotent completion; no duplicate business effect.
25. Where practical, prepare a separate stale-revision operation after changing the target revision.
    - Expected: stale revision cannot silently overwrite newer state.

## 7. R2 representative mutation — reason gate and semantic idempotency

Use `wallet.adjust` against a disposable wallet balance.

26. Prepare without reason.
    - Expected: rejected.
27. Prepare correctly with a unique idempotency key and a small reversible adjustment.
    - Expected: operation can become READY without an invented confirmation/approval step.
28. Apply.
    - Expected: wallet changes exactly once and Player 360 reflects the new amount.
29. Repeat the exact same semantic request with the same idempotency key.
    - Expected: replay/convergence, not a second balance change.
30. Reuse that idempotency key with different semantics, such as a different delta/reason/target.
    - Expected: idempotency conflict; changed semantics must not be accepted as the same operation.
31. Inspect audit evidence.
    - Expected: actor, operation type, target, reason, correlation/idempotency context and final result are attributable without erasing the original operation.
32. If cleanup is needed, use the canonical semantic compensation path rather than editing the wallet table directly.
    - Expected: compensation creates separate evidence and does not erase the original mutation history.

## 8. R3 representative mutation — explicit confirmation

Use `battle.force_cancel` only on a deliberately disposable/test battle.

33. Prepare without reason.
    - Expected: rejected.
34. Prepare without expected revision.
    - Expected: rejected.
35. Prepare correctly.
    - Expected: operation remains non-applicable until the required confirmation is recorded.
36. Attempt apply before confirmation.
    - Expected: denied by operation state; no battle change.
37. Attempt confirmation by a principal other than the proposer.
    - Expected: denied; only the proposing principal may confirm its operation.
38. Confirm as proposer after reviewing target and blast radius.
    - Expected: operation becomes READY because this representative R3 policy requires no independent approval.
39. Apply.
    - Expected: test battle is force-cancelled once through the canonical operation.
40. Re-read Player 360 and battle state.
    - Expected: active battle/state reflects the governed result and no unrelated player state is damaged.
41. Inspect audit evidence.
    - Expected: prepare/confirmation/apply chain is attributable and complete.

## 9. Batch authorization-bypass checks

42. Run `batch.preview` on a small, disposable target set.
    - Expected: reason is required and preview freezes/identifies the intended target set for review.
43. Prepare `batch.execute.low_risk` using the corresponding preview/batch identity and current expected revision.
    - Expected: explicit confirmation is required before execution.
44. Attempt to expand or silently substitute the target set after preview/approval semantics were established.
    - Expected: refused or detected; batch must not become a dynamic-query blast-radius bypass.
45. Verify `batch.execute.high_risk` is unavailable from the current Registry.
    - Expected: high-risk child operations retain their individual R3/R4 gates; an unregistered high-risk batch shortcut cannot be invoked.

## 10. R4 dual-control path — full ceremony

Preferred target: `admin.role.assign` on a **disposable UAT AdminPrincipal** whose final role state is safe and understood. An equivalent registered Tier 4 operation may be used if safer for the accepted environment.

The proposer and approver must be different people/principals.

46. Attempt prepare without GLOBAL scope.
    - Expected: denied because the operation is GLOBAL_ONLY.
47. Attempt prepare without reason.
    - Expected: rejected.
48. Attempt prepare without expected revision.
    - Expected: rejected.
49. Prepare correctly with a unique idempotency key and correlation id.
    - Expected: operation enters `VALIDATED`; it cannot skip required simulation.
50. Attempt confirm before simulation.
    - Expected: denied by operation state.
51. Run simulation as the proposer.
    - Expected: simulation records reviewable before/after/summary information and advances to the confirmation gate.
52. Attempt simulation using a principal other than the proposer.
    - Expected: denied.
53. Review the simulation and explicitly confirm as proposer.
    - Expected: operation advances to `PENDING_APPROVAL`.
54. Attempt self-approval by the proposer.
    - Expected: denied; self-approval is forbidden.
55. Attempt approval with an empty/blank approval reason.
    - Expected: rejected.
56. Approve using a second authorized principal with GLOBAL scope and a real approval reason.
    - Expected: required independent approval is durably recorded and the operation becomes READY.
57. Apply the operation using an authorized principal.
    - Expected: the Tier 4 business effect occurs exactly once through the registered implementation.
58. Re-read the target state and admin authorization state.
    - Expected: final state matches the approved simulation/intent; no hidden extra privileges or unrelated changes occurred.
59. Re-apply the already APPLIED operation.
    - Expected: no repeated business effect.
60. Inspect full audit evidence.
    - Required: proposer, simulation, confirmation, independent approver and approval reason, apply/result, operation fingerprint/revision context, correlation id.
61. Restore/normalize the disposable UAT target using the ordinary governed path if cleanup is required.
    - Expected: cleanup itself is auditable; no raw SQL shortcut.

## 11. Second R4 policy spot-check

Use `content.release.publish` only to the extent safe for the accepted environment.

62. Verify it is GLOBAL_ONLY and registered as Tier 4.
63. Verify missing reason and missing expected revision are rejected.
64. Verify simulation is mandatory before confirmation.
65. Verify confirmation alone does not bypass the required independent approval.
66. Verify self-approval is rejected.
67. Do not publish a throwaway content release merely to satisfy this runbook if that would create release-state risk. A non-destructive gate proof is sufficient here when the full R4 success ceremony was already completed in section 10.

## 12. Policy drift and Registry integrity

68. Confirm the operation records used in the UAT preserve the registered capability, risk tier, authorization mode and policy snapshot.
69. Confirm the runtime fails closed when a stored operation snapshot no longer matches the current Registry definition.
    - This may be supported by existing automated proof/evidence if safely inducing real policy drift in the accepted environment would itself be destructive.
70. Confirm an operation name/capability that exists only in the catalog but is not currently registered cannot be treated as executable merely because the capability key exists.

## 13. Audit and evidence quality

Capture this header:

```text
UAT date/time:
Operators:
Target environment:
Git SHA:
Runtime/deploy revision:
Schema/migration verification:
Content release:
Ruleset:
Ordinary/limited principal reference:
Tier 3 principal reference:
Tier 4 proposer reference:
Tier 4 approver reference:
Disposable player reference:
Disposable Tier 4 target reference:
```

For every numbered step:

```text
Step:
Operation / surface:
Expected:
Actual:
Verdict: PASS | FAIL | BLOCKED
Evidence: screenshot/log/audit/operation reference
Incident/issue: [required when FAIL/BLOCKED]
```

Final record:

```text
Overall verdict: PASS | FAIL | BLOCKED
Player 360 ordinary read: PASS/FAIL/BLOCKED
Sensitive-data boundary: PASS/FAIL/BLOCKED
Capability/scope enforcement: PASS/FAIL/BLOCKED
R1 representative mutation: PASS/FAIL/BLOCKED
R2 representative mutation: PASS/FAIL/BLOCKED
R3 representative mutation: PASS/FAIL/BLOCKED
Batch bypass checks: PASS/FAIL/BLOCKED
R4 dual-control ceremony: PASS/FAIL/BLOCKED
Audit/idempotency/policy integrity: PASS/FAIL/BLOCKED
Open P0 blockers:
Open P1 blockers:
Known non-blocking issues:
Operator sign-off:
Evidence bundle/reference:
```

## 14. PASS criteria for checklist 17.10

A PASS suitable for closing 17.10 requires all of the following:

- exact immutable revision under test is recorded;
- Player 360 ordinary read is cross-checked against authoritative state;
- unsupported Player 360 sections are not falsely represented as complete;
- sensitive Player 360 access is denied without the dedicated capability and succeeds with correct capability/scope;
- GLOBAL_ONLY vs subject scope behavior is demonstrated;
- missing reason and expected revision fail closed where required;
- semantic idempotency replay/conflict behavior is demonstrated;
- at least one representative confirmation-gated R3 operation is exercised end-to-end;
- high-risk batch cannot bypass child-operation gates;
- at least one registered Tier 4 operation completes simulation → proposer confirmation → independent approval → apply using disposable UAT state;
- self-approval is proven impossible;
- post-apply Player 360/domain reads agree with the intended result;
- audit evidence is sufficient to identify who proposed, confirmed, approved and applied the governed actions;
- no raw SQL/manual table patch is used as the administrative surface;
- zero open P0/P1 blocker affects the accepted admin safety flow.

If any required slice fails, 17.10 remains open. Fixes must follow the normal reviewed GitHub path and the affected UAT slice must be repeated against the new immutable revision.

## 15. Safety and integrity constraints

During this UAT, never:

- expose database credentials, `.env` values, WhatsApp auth material or secret keys in evidence;
- place real sensitive player identifiers in public screenshots/tickets when a redacted reference is sufficient;
- grant a broad owner/master role to a real operator merely to make UAT convenient;
- use raw SQL to reproduce a registered admin mutation;
- bypass reason, revision, simulation, confirmation or approval gates;
- approve your own operation when independent approval is required;
- reuse an idempotency key for changed semantics;
- test Tier 4 operations on a production principal/content release when disposable staging state can prove the same control;
- create a high-risk batch shortcut around R3/R4 child-operation gates;
- erase/overwrite original audit history during compensation or cleanup.

## 16. Relationship to other Phase 17 gates

- 17.7 WhatsApp client/admin flow UAT remains independently required.
- 17.10 closes only after this Player 360 + risk-operation human UAT is actually executed and passes.
- provider-live staging smoke, backup/alerts, privacy/access review, production release/tag, final snapshot, handoff, monitoring and final acceptance remain independent Phase 17 gates.
- creating or merging this runbook changes **no release percentage by itself**.
