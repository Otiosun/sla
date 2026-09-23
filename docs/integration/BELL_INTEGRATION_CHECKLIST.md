# Bell — Integration Checklist

This file is the stable execution checklist for the Bell integration. Update status; do not redefine the sequence casually.

Status legend: `[ ]` pending, `[~]` in progress, `[x]` completed.

- [~] **0. Integrated baseline** — TypeScript/Biome/tests, PR #159 authoritative battle write-back, migration-chain coherence.
- [ ] **1. Reception v2** — port PR #157 surgically while preserving the newer World/PVE runtime.
- [ ] **2. Contextual player flow** — authoritative-state-derived home/menu, `/` canonical, `$` legacy alias, no internal slugs/revisions.
- [ ] **3. Exploration → Encounter → PVE/Capture** — `/explorar`, battle/capture/flee, terminal Encounter lifecycle.
- [ ] **4. Zhoulia content model** — typed DRAFT content; Vila dos Arrozais → Campos de Yun first, then remaining areas.
- [ ] **5. World services** — Center/Hana, Mart, PC, Fishing fully contextualized.
- [ ] **6. PVP** — challenge/accept, two-player resolution, persistence and failure/restart proofs.
- [ ] **7. Hub companion** — port PR #161 against local migration 0052; no web gameplay.
- [ ] **8. Virtual UAT** — same functional pipeline with PostgreSQL + fake transport; no real WhatsApp as release gate.
- [ ] **9. Final consolidation** — migrations, regression matrix, complete journeys, continuity checkpoint/package.

## Current Baseline-0 batch

- [x] Patch the known local TypeScript blockers captured in the 2026-09-16 diagnostic.
- [x] Port PR #159 source write-back boundary into standard Battle and PVP persistence.
- [~] Run the canonical local verification (`pnpm check`) on the user's Node 24/pnpm 11 environment.
- [ ] Resolve any newly exposed failures as one batch.
- [ ] Confirm migration chain 0001–0052 on PostgreSQL.
- [ ] Mark Baseline 0 complete, then immediately begin Reception v2 + Player Flow integration.

## Fixed decisions

- Goal: integrate the whole RPG as quickly as possible without creating a second source of truth or known regressions.
- Product validation is headless/virtual; a real WhatsApp session is not a release gate.
- Visible prefix is `/`; `$` remains compatibility only.
- `/ir` is the canonical travel command; do not introduce `/viajar` now.
- Hub is companion-only; no web exploration/battle/capture.
- Do not invent missing lore/NPC names/routes.
- A newer explicit project decision overrides an older slice-specific task restriction.
