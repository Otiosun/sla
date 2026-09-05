# Phase 17 — WhatsApp Human UAT Runbook

Status: execution runbook for checklist item **17.7 — UAT do fluxo completo com cliente/admin**.

This document prepares the human UAT. Its existence **does not close 17.7**. The checklist item may only be marked complete after the flow is executed against the accepted target and the evidence below is recorded with a final PASS verdict and no open P0/P1 blocker.

A local demo is useful as a rehearsal, but it does not replace Phase 17.5 provider-live staging smoke or other external release gates.

## 1. Preconditions

Record and verify all of the following before starting:

- [ ] exact immutable Git SHA under test;
- [ ] deployed/runtime revision matches the intended SHA/artifact;
- [ ] database migrations/schema verification passed;
- [ ] active content release and ruleset identifiers recorded;
- [ ] exactly one WhatsApp runtime owns the session;
- [ ] WhatsApp provider is `baileys`;
- [ ] the Reception group is registered in the canonical community-group registry;
- [ ] Reception capabilities are exactly appropriate for the flow: `admin.review`, `onboarding`, `player.basic`;
- [ ] a valid active RPG admin principal is available;
- [ ] a genuinely fresh player number is strongly preferred;
- [ ] screenshots/logs are configured so secrets and credentials are not exposed;
- [ ] the target database is canonical for the run and is not the old divergent WIP database.

Stop the UAT and mark it BLOCKED if any precondition cannot be established safely.

## 2. Registration — player flow

For every step, record expected result, actual result, PASS/FAIL, and evidence reference.

1. A fresh/new player sends a message in the registered Reception group.
   - Expected: the runtime recognizes the actor/group under the canonical Reception policy and does not grant game-world capabilities.
2. Start registration with `$registrar`.
   - Expected: a registration session starts without creating a Pokémon or granting ACTIVE access.
3. Choose one registration mode: guided or full form.
   - Expected: both modes operate on the same draft model; switching modes must not create a second character/draft authority.
4. Fill all required fields:
   - name;
   - age;
   - gender/pronouns;
   - appearance;
   - personality;
   - history/summary;
   - starter intent;
   - canonical region Zhoulia.
5. Edit at least one field before submission.
   - Expected: the edited value becomes the current draft value without producing an immutable submitted revision yet.
6. Run `$salvar`.
   - Expected: the current draft persists and can be resumed; it is still not SUBMITTED.
7. Run `$confirmar`.
   - Expected: a complete human-readable preview is shown and no submission is created solely by previewing.
8. Verify the preview values, including starter and region presentation.
   - Expected: friendly labels/names are shown; raw internal IDs must not leak to the player-facing preview.
9. Run `$confirmar sim`.
   - Expected: save + freeze + submit occur atomically; the submitted revision becomes immutable.
10. Verify staff delivery.
    - Expected: the responsible Reception staff/admin path receives the submission notification/mention through the outbox/delivery mechanism.

## 3. Admin review and requested-changes path

11. The authorized RPG admin replies to the submission notification with `$verficha`.
    - Expected: the correct submission is resolved from the durable message mapping and displayed with friendly values.
12. Verify authorization semantics.
    - Expected: authority comes from the RPG admin principal/capabilities, not merely from WhatsApp group-admin status.
13. Run `$ajustes` with an appropriate manual reason/comment using the supported command format.
    - Expected: status becomes CHANGES_REQUESTED; the prior submitted revision remains preserved.
14. The player edits the requested field(s).
    - Expected: editing does not mutate the immutable prior submission.
15. The player reviews and resubmits.
    - Expected: a new immutable revision/submission is created and routed for review.
16. The authorized admin runs `$verficha` on the new submission.
    - Expected: the new values are visible and the historical prior revision remains independently preserved.

## 4. Approval, provisioning, and activation

17. The authorized admin approves the current submission with `$aprovar`.
18. Verify the transition into provisioning.
    - Expected: approval is committed before external delivery side effects become authority.
19. Verify mechanic profile creation/ensure.
    - Expected: exactly one canonical mechanic profile exists for the player.
20. Verify region.
    - Expected: canonical real region is Zhoulia.
21. Verify starter grant.
    - Expected: the selected starter is created exactly once during provisioning; registration intent alone must never have created it earlier.
22. Verify onboarding state.
    - Expected: onboarding reaches COMPLETE through the canonical progression.
23. Verify initial location.
    - Expected: a valid initial location is established according to the active content/ruleset.
24. Verify PlayerAccess.
    - Expected: access reaches ACTIVE only after provisioning invariants succeed.
25. Verify Reception announcement/delivery.
    - Expected: the activation result is delivered after authoritative state is committed.
26. Exercise an idempotent retry/replay-safe path where operationally supported.
    - Expected: no duplicate starter, profile, access row, or equivalent authoritative resource is created.
27. Have the now-ACTIVE player interact with Reception again.
    - Expected: registration/onboarding does not restart.

## 5. Negative authorization and group-policy checks

28. Attempt a WORLD/PVE/PVP command from Reception using the player.
    - Expected: denied/fail-closed because Reception does not own those capabilities.
29. Attempt an admin review operation as an ordinary player.
    - Expected: denied and auditable; no state change.
30. If a test account is WhatsApp group admin but not an RPG admin principal, attempt an RPG admin operation.
    - Expected: denied; WhatsApp group administration does not confer RPG authority.
31. Exercise an unknown/unregistered group against a protected bot flow where safe to do so.
    - Expected: fail-closed.

## 6. Optional rejection path

If the accepted 17.7 session includes the negative final-review path:

1. create/use a separate disposable registration submission;
2. have an authorized admin run `$rejeitar` with the supported reason/comment;
3. verify REJECTED is recorded without activating/provisioning the player;
4. verify audit/delivery evidence;
5. do not reuse a production player's canonical accepted character merely to test rejection.

## 7. Evidence record

Capture this header for the UAT execution:

```text
UAT date/time:
Operator(s):
Target environment:
Git SHA:
Runtime/deploy revision:
OCI/artifact identifier if applicable:
Schema/migration verification:
Content release:
Ruleset:
WhatsApp provider: baileys
WhatsApp session reference: [safe reference only]
Reception group reference: [redacted/safe reference]
Admin principal reference: [safe reference]
Fresh player reference: [safe reference]
```

For each numbered step capture:

```text
Step:
Expected:
Actual:
Verdict: PASS | FAIL | BLOCKED
Evidence: screenshot/log/audit/event reference
Incident/issue: [required when FAIL/BLOCKED if investigation is needed]
```

Final execution record:

```text
Overall verdict: PASS | FAIL | BLOCKED
Open P0 blockers:
Open P1 blockers:
Known non-blocking issues:
Operator sign-off:
Evidence bundle/reference:
```

## 8. Evidence quality requirements

A PASS suitable for closing 17.7 must establish all of the following:

- exact immutable SHA/revision under test;
- human execution of the player + admin flow, not merely automated unit/integration tests;
- immutable revision behavior across submission and requested changes;
- successful approval → provisioning → ACTIVE path;
- starter/profile provisioning idempotency evidence;
- group/capability negative checks;
- relevant audit/outbox/state evidence where applicable;
- zero open P0/P1 blocker affecting the accepted flow;
- evidence references sufficient for another operator to audit what happened.

If any required step fails, 17.7 remains open. Fixes must go through normal reviewed GitHub changes and the affected UAT slice must be repeated against the new immutable revision.

## 9. Safety and integrity constraints

During UAT, never:

- paste or publish `.env` contents;
- expose a database password or full `DATABASE_URL` secret material;
- expose `WHATSAPP_AUTH_KEY_BASE64` or encrypted-session key material;
- run two runtimes using the same WhatsApp credentials/session;
- point current canonical code at the old divergent `pokemon_rpg_dev` WIP migration history;
- delete/reset the legacy database as part of UAT preparation;
- overwrite `.env.whatsapp` or stored auth state casually;
- rewrite, renumber, or delete already-applied canonical migrations;
- weaken TLS using `rejectUnauthorized:false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `sslmode=no-verify`, or equivalent bypasses;
- treat a delivery message as mechanical authority when the authoritative DB operation did not commit.

## 10. Relationship to other Phase 17 gates

- 17.5 provider-live post-deploy smoke remains independently required.
- 17.7 closes only after this human complete-flow UAT is actually executed and passes.
- 17.10 has its own Player 360/risk-sensitive administrative UAT scope and is not closed by this runbook.
- production backup/alerts, privacy/access review, release/tag, final snapshot, handoff, monitoring, and final acceptance remain independent gates.

Creating or merging this runbook changes **no release percentage by itself**.