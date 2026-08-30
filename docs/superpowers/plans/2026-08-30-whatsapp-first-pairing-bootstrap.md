# WhatsApp First Pairing Bootstrap Implementation Plan

> **For agentic workers:** Use TDD and verification-before-completion. Do not perform a real provider pairing in CI.

**Goal:** Add an explicit, one-shot, fail-closed operator ceremony that can create the first encrypted PostgreSQL-backed Baileys auth session without changing the normal long-running runtime contract.

**Architecture:** The normal bot keeps `allowCreate:false`. A separate operator path opens `PostgresBaileysAuthBinding` in create-only mode under its existing PostgreSQL advisory lease, drives one Baileys pairing attempt through injected provider/socket contracts, exposes QR material only through an explicitly sensitive operator sink, waits for provider `open`, then stops and releases all resources. Existing sessions are never silently overwritten. The live provider path is additionally gated against the currently pinned Baileys `7.0.0-rc14`, because upstream pairing is presently known broken; unit/integration proofs use deterministic fakes and PostgreSQL rather than WhatsApp.

**Upstream risk:** As of 2026-08-30, WhiskeySockets/Baileys #2737 reports QR pairing failure on rc14 due to unhandled `companion_reg_refresh`, and #2765 is an open candidate fix. #2749 is an open pre-login ACK fix. Do not claim provider-live pairing compatibility until an upstream release or separately reviewed patch is adopted and proven.

## Global invariants

- staging/production only;
- exact full `DEPLOY_REVISION` required for audit context;
- normal runtime remains `allowCreate:false`;
- bootstrap is create-only: an existing session fails closed;
- the existing PostgreSQL advisory lease serializes pairing against runtime/other pairing attempts;
- auth credentials and Signal keys remain encrypted in PostgreSQL through `PostgresBaileysAuthBinding`;
- QR/pairing secrets never enter StructuredLogger, JSON logs, Drive, CI artifacts or error strings;
- provider success means actual `connection=open`, not merely QR emission or process liveness;
- bounded timeout and cleanup on every exit path;
- no real provider call in CI;
- known-broken provider versions are rejected before network pairing starts.

---

## Task 1 — Atomic create-only auth bootstrap

**Files:**
- Modify: `src/adapters/whatsapp/postgres-baileys-auth.ts`
- Modify/Add tests under the existing WhatsApp adapter test area.

- [ ] Add a typed `WhatsAppAuthAlreadyBootstrappedError`.
- [ ] Add an opt-in `requireCreate`/create-only option that is only valid with `allowCreate:true`.
- [ ] Inside the existing advisory lease, reject an existing session before returning a binding.
- [ ] Preserve all current runtime behavior when the option is absent.
- [ ] Prove absent session creates once; exact second attempt fails; concurrent lease remains fail-closed; encryption/CAS tests remain green.

## Task 2 — Pairing operation core

**Files:**
- Add: `src/operations/whatsapp-pairing-bootstrap.ts`
- Add: `src/operations/whatsapp-pairing-bootstrap-config.ts`
- Add tests under `tests/runtime` or a new `tests/operations` area.

- [ ] Define a sensitive QR sink interface; raw QR is only passed to that sink.
- [ ] Define an injected pairing adapter/socket boundary so tests never hit WhatsApp.
- [ ] Require staging/production, session key, canonical 32-byte base64 auth key, key version, full deployment revision, positive timeout.
- [ ] Reject known-incompatible Baileys `7.0.0-rc14` for production provider execution before opening a network socket.
- [ ] Open auth with `allowCreate:true` + create-only semantics.
- [ ] Resolve only after `CONNECTED`/provider `open`.
- [ ] Reject logout/provider error/timeout.
- [ ] Always stop provider, close auth lease and close DB resources at CLI boundary.
- [ ] Never put QR/provider secret in thrown error or ordinary logger payload.

## Task 3 — Explicit operator CLI and docs

**Files:**
- Add: `scripts/operations/bootstrap-whatsapp-session.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Add: `docs/operations/whatsapp-first-pairing.md`
- Modify: `docs/operations/release-recovery-runbook.md`

- [ ] Add `pnpm ops:bootstrap:whatsapp`.
- [ ] Refuse CI/non-interactive stdout for any path that could expose sensitive pairing material.
- [ ] Keep provider compatibility failure explicit and non-secret.
- [ ] Document that pairing is a one-time bootstrap, not session rotation/recovery.
- [ ] Document upstream rc14 blocker and exact acceptance evidence needed before live use.
- [ ] Do not write QR/raw auth into examples or docs.

## Task 4 — Permanent proof and PR

**Files:**
- Extend the existing WhatsApp/Release Foundation proof surface only where useful; avoid a redundant workflow.

- [ ] RED first for create-only semantics and pairing lifecycle.
- [ ] GREEN implementation.
- [ ] `pnpm check`/CI/WhatsApp Proof/Release Foundation all green.
- [ ] Review diff for secret leakage and accidental `allowCreate:true` in normal runtime.
- [ ] Open PR with exact upstream-blocker boundary.
- [ ] Do not increase 97.40% or close 17.2/17.3/17.5 from simulated tests.
