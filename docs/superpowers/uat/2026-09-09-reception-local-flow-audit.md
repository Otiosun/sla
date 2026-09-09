# Reception continuation — confirmed joins and slash commands

Branch: `feat/world-services-v1`, PR #158, unmerged. Starting code baseline: `346ed6597b2909c27b6c1037ced23ddb87b255fc`. Progress remains **98.00%**. PR #157 and #159 are not imported or modified.

This continues the World Services local UAT. It does not close the WhatsApp UAT gate or replace the existing product decisions. The operator configured the existing `Recepcao` group successfully through `/grupo recepcao Recepcao`. Read-only verification confirmed RECEPTION plus onboarding, admin.review, player.basic, world, pve and pvp. Do not ask the operator to configure another group.

## Observed defects and exact RED → GREEN

1. Baileys did not forward participant membership events. `confirmed Reception membership > accepts actual add/remove only, preserves opaque IDs and ignores stopped sockets` failed with 0 calls instead of 2. Added an ordered participant event handler with stop/reconnect generation guards. Requests, promotions, demotions and the bot's own identity do not enter Reception.
2. `does not welcome an add-shaped notification when the person is still outside the actual group` failed because an add-shaped notification alone triggered the callback. The adapter now fetches current group metadata and requires the exact opaque participant ID to be present. `group.join-request` is never subscribed to. Metadata failure produces no welcome. No phone/LID identity rebinding is inferred.
3. `preserves the real mention in an image caption` failed because IMAGE serialization omitted `mentions`. IMAGE now validates and preserves mention JIDs alongside the caption.
4. `commits membership and outbox together; deduplicates add across repository instances and preserves rejoin generations` initially failed because the method did not exist. The existing 0029 presence table now records observed join/leave generations. Presence and Outbox insertion share one transaction and one group/player lock. Concurrent or repeated adds while present create one message; a real leave/rejoin creates a new generation. Injected welcome-read and Outbox-write failures roll back the presence change. Sending retries use the existing durable Outbox and deterministic WhatsApp message ID.
5. `guides an existing draft to /continuar and /ficha` and `guides CHANGES_REQUESTED to /editar while preserving the existing ficha` failed against the old `$` suggestions. All advertised commands in runtime source now use `/`; legacy input aliases remain accepted. SQL parameters and technical `$` identifiers were not rewritten. Existing operational proof assertions were updated to expect slash commands.
6. `offers the next confirmation step when viewing a complete saved ficha` failed because `/ficha` ended without an instruction. Complete fichas now lead to `/confirmar`, followed by explicit `/confirmar sim`; incomplete fichas lead to the guided editor and `/salvar`.
7. `does not consume a command as a trainer field: /` and the `/menu` variant failed in the registration conversation admission boundary. Both command prefixes are now excluded from freeform field capture.

The user's Rotom caption is covered by an exact text assertion. The supplied JPEG is stored unchanged at `assets/reception/rotom-welcome.jpg`, SHA-256 `92c29b0d6bbfb42eae6b3ace760ef8fa245d04c4911410de5dc43b7097d153fd`. The runtime uses a public HTTPS URL pinned to asset commit `c041ed9ab80fdaf1156c14867d14147053641aaa`.

## Current branch's full player path

These are the V1 routes actually composed by this branch. The saved V2 conversation rows in the local DB are preserved, but this branch's editor is in memory. Do not claim V2 autosave or import PR #157 to simulate it. `/salvar` persists a draft; `/continuar` restores it after restart. Unsaved edits and confirmation previews do not survive a runtime restart.

| Step | Human action in the same Reception | Expected result |
| --- | --- | --- |
| Admission request | Request entry through the invitation flow; do not approve yet | No Rotom message and no new Reception presence/outbox row |
| Confirmed entry | Approve the request, join through a permitted invitation, or add the participant | Confirm current membership; one image with the supplied caption and real mention for a newcomer |
| Existing registration | Rejoin with the same identity | Draft → `/continuar`/`/ficha`; submitted → analysis; changes requested → `/editar`; approved/provisioning → wait; active → return message; no reset |
| Start | `/registrar` | Choose guided or complete mode |
| Guided mode | Reply `1` to the exact bot prompt | Seven fields, in order: trainer name, age, gender/pronouns, appearance, personality, backstory, starter |
| Guided answers | Reply to each new bot prompt | Age must be a positive integer; required text must be non-empty; starter number/name resolves to an active canonical option |
| Complete mode | Reply `2`, then reply with the completed template | Same canonical fields and starter validation; no submission yet |
| Persist/resume | `/salvar`, later `/continuar` | Optimistic draft revision; restore saved values and first missing field |
| Review own ficha | `/ficha` | Read-only display, dirty state and next step |
| Preview | `/confirmar` | Validate every field and show the exact snapshot; no submission |
| Submit | `/confirmar sim` | Save and submit atomically; immutable SUBMITTED revision and review notification; duplicate Inbox does not submit twice |
| Staff review | Authorized RPG admin replies `/verficha` to the exact review notification | Friendly ficha display; reply anchor identifies the specific review/revision |
| Staff decision | Reply `/aprovar`, `/ajustes` or `/rejeitar` to that notification | Audited capability/scope check and revision guard; no authority inferred from WhatsApp group membership |
| Changes requested | Player sends `/editar`, edits, previews and confirms again | Preserve prior values; create a new review revision rather than rewriting the submitted snapshot |
| Provisioning | No extra human command | Profile → region → starter preparation/grant → onboarding COMPLETE → initial world location → access ACTIVE → durable announcement |
| Enter gameplay | `/menu`, `/perfil`, `/equipe`, `/onde` | World actions require ACTIVE and mechanical readiness; this Reception's capabilities allow gameplay in the same group |

A new guided happy path needs **11 player messages** before staff review (start + mode + seven fields + preview + final confirmation), excluding optional `/ficha` and `/salvar`. Complete mode needs **5**. For the existing complete saved draft, the reviewable path is `/continuar` → `/ficha` → `/confirmar` → `/confirmar sim`, then staff `/verficha` and `/aprovar`. Human steps must be executed progressively against actual responses.

## Verification and preserved local state

- 233 tests across 60 files passed after membership/prefix changes, including PostgreSQL registration, review delivery, Reception presence and group setup. Later next-step and command-boundary changes passed their focused suites (17 and 12 tests respectively). TypeScript and changed-file Biome checks passed.
- `db/proofs/reception_registration_e2e.ts` passed against a newly created, migrated and seeded **disposable** PostgreSQL database. It now exercises confirmed membership and repeated-add suppression, slash commands, saved-draft restart, starter change before submission, exact review reply, requested adjustments, replay, provisioning retry and final ACTIVE/COMPLETE with exactly one starter and one location. Only the fake message adapter was used.
- The first disposable proof attempt inherited staging configuration and was refused because its two test DB roles matched. The harness was corrected to `APP_ENV=test` for its disposable child processes. The local env was not changed. Both disposable databases were removed after their runs.
- Local read-only revalidation: 41 migrations; two onboarding NEW players; zero player_access rows (canonical reader returns PENDING); zero submitted reviews; saved `Teste` draft remains revision 6. No DB/player/content/session reset or manual approval was performed.
- No RPG runtime was running at this continuation's process/DB check. The old ignored runtime checkpoint was historical. Record a fresh actual HEAD and verify one session owner when starting the updated runtime.

## Human gate and World Services continuation

First verify request versus actual entry in the existing Reception, using a participating account without a ficha for the newcomer artwork case. Return screenshots of the pending request and confirmed entry, the Rotom image/caption/mention, and approximate times. A returning account must receive its state-aware response instead of being called a new trainer. Do not delete an existing player to obtain the artwork case.

Then resume `Teste` through the saved-draft flow and collect the actual review/approval evidence. The active local Zhoulia release still needs the additive World Services UAT content preparation identified in the preflight. Do not start A1 without player/location/content readiness.

UAT A–J remains pending. At A3, stop and say **CHEGOU A HORA DAS FOTOS DO POKÉ MART**. Do not count these automated tests as WhatsApp media UAT or raise canonical progress.

GitHub contains this code/evidence checkpoint. Google Drive synchronization is pending because no Drive connector is available in this continuation; do not report it as updated.
