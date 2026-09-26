# World Services local preflight continuation

Baseline: `54535edf11f8033a79ec4a65b35ff80a33648a71`, branch `feat/world-services-v1`, PR #158 remains unmerged. Canonical progress remains 98.00%.

## Observed environment

- Existing checkout safely switched from detached `1a681f795480e5617551054852176edaafc14ec0`; four untracked `.phase15-*` directories preserved.
- Existing localhost PostgreSQL demo preserved. Full custom-format pg_dump and original env backed up outside checkout before migration.
- Canonical migration CLI applied 0035–0041; schema verification passed with 41 migrations. No player, auth, or content reset.
- Two players remain onboarding NEW, with no approved access, profiles, location or roster. One existing registration draft is at REVIEW, not submitted.
- Only Reception is registered, with onboarding/player.basic/admin.review. No world group configured.
- Active local Zhoulia release has no Arrozais facility/fishing configuration or active purchase offers. Preserve its local starter/content choices when preparing a successor release.
- Existing `pokemon-local` auth session retained. No demo runtime was running during migration; unrelated PM2 bots were not stopped.
- Added only ENCOUNTER_RNG_KEY_BASE64 and ENCOUNTER_RNG_KEY_VERSION to the backed-up local env. Generated a new random 32-byte key because none existed and the demo had zero encounters. Original env content preserved byte-for-byte as prefix. No secret is committed.

## Concrete defect and correction

The operator must select the gameplay group through WhatsApp. CommunityService existed but the operational router had no group administration route; `/grupo` was silently excluded by command admission.

Command: `/grupo jogo Nome do grupo`, sent by an RPG administrator inside the desired gameplay group. `$grupo` is also accepted by the standard router. Requires ACTIVE AdminPrincipal, `community.group.manage` at risk tier 3 and GLOBAL scope. WhatsApp group admin status alone does not grant access.

Initial implementation registered unknown groups as GAME and refused non-GAME groups. That restriction was superseded by the explicit operator decision below. The dedicated bootstrap route checks the full AdminService boundary before mutation; normal unknown-group gameplay admission remains unchanged.

RED: operational PostgreSQL integration test failed because command admission returned false and dispatch returned Unknown command. GREEN/regression: 70 tests across 14 files, including real disposable PostgreSQL setup, restart-style replay, unauthorized sender, missing global scope, private/invalid input, Reception preservation, concurrent additive configuration and injected audit-failure rollback/retry.

Local test invocation explicitly uses an ignored `.tmp/uat-vitest.config.mjs` containing `export default {};` because Vitest otherwise finds an unrelated parent Downloads/vite.config.ts. This is local harness isolation, not a product-code fix.

## Next human gate

### Operator decision after real WhatsApp rejection

The operator sent `/grupo jogo Teste` in the existing Reception. Authorization succeeded, but the initial non-GAME restriction rejected it; the generic error renderer hid the reason. The group was not modified. This was an incorrect product assumption, not a permissions failure.

Approved structure: the operator activates the bot in the desired group. A specific group role enables its specialized flows, without imposing exclusive-command restrictions for now. Reception will host all available gameplay for UAT. A group per NPC, facility or command is not required. Location authority remains per player, independent of group display name.

Updated command: `/grupo recepcao Nome do grupo` (also accepts `recepção`). Creates or marks the current active group as RECEPTION and additively enables onboarding, admin.review, player.basic, world, pve and pvp. Existing name/capabilities are retained; `/grupo jogo` on Reception preserves its role. Retired groups remain blocked. Administrator authority and player mechanical/access checks are unchanged. No exclusive group levels are implemented.

RED: Reception setup returned ok=false in the operational PostgreSQL integration test. GREEN: 66 regression tests across 13 files, followed by 8/8 group integration tests including accented Reception creation and repeated nonexclusive setup. No manual group update or player reset was used.

Completed: the operator sent `/grupo recepcao Recepcao` and confirmed success. Read-only DB verification found the same Reception with onboarding, admin.review, player.basic, world, pve and pvp. Do not repeat group configuration.

Continue with [the Reception flow audit](2026-09-09-reception-local-flow-audit.md), then resume the preserved draft through human submission/review and canonical provisioning; prepare missing local content without replacing Zhoulia decisions. Start exactly one demo runtime on the recorded commit. Do not claim A1 started until player/location/content gates are satisfied.

At A3 explicitly announce: CHEGOU A HORA DAS FOTOS DO POKÉ MART. A–J are still pending. No merge of #158 or #157, and no #159 changes.
