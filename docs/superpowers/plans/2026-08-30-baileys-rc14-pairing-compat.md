# Baileys rc14 Pairing Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing one-shot WhatsApp bootstrap eligible for a real staging QR pairing attempt by applying a repository-owned, auditable compatibility patch to exact `@whiskeysockets/baileys@7.0.0-rc14`, while keeping unpatched/unknown provider identities fail-closed.

**Architecture:** Keep the official npm package and its exact rc14 resolution; apply a checked-in pnpm `patchedDependencies` delta rather than consuming a mutable fork/Git branch. The patch ports only the two upstream pairing fixes needed by our QR bootstrap: pre-login notification ACK safety from WhiskeySockets/Baileys #2749 and `companion_reg_refresh` ADV-secret rotation/current-ref QR re-render from #2765. Runtime eligibility is based on both the installed version and an exact compatibility marker carried by the patched package; repository tests independently prove the simulated protocol behavior. Passing CI means only `ELIGIBLE_FOR_STAGING_PAIRING`, never provider-live success.

**Tech Stack:** Node.js 24.19.0, TypeScript 7, pnpm 11.23.0 patchedDependencies, Vitest 4, Baileys 7.0.0-rc14, GitHub Actions.

**Spec:** `docs/operations/whatsapp-first-pairing.md` plus the Phase 17 fail-closed first-pairing contract already integrated in `main`.

## Global Constraints

- Base branch/commit at plan creation: `main` = `c3f38e3e52e07ed117fbdce910be8c1e978dd9f7`.
- Work only on `fix/phase17-baileys-pairing-compat-v1`; never commit directly to `main`.
- Keep `@whiskeysockets/baileys` dependency version exactly `7.0.0-rc14`; do not install an upstream fork/Git SHA.
- Patch source basis: WhiskeySockets/Baileys #2749 head `38686677889a4db5356da51aa9517eb12c1e0866` and #2765 head `4f263f0e365c2e74dd1b824031d1c5910f518c26`.
- #2749 production delta is only pre-login ACK safety: `authState.creds.me!.id` → `authState.creds.me?.id` in `sendMessageAck`.
- #2765 production behavior: accept only `companion_reg_refresh` or `pair-device-rotate-qr` child, rotate `advSecretKey` with 32 CSPRNG bytes for an unregistered session, emit `creds.update`, and re-render the current QR ref without consuming a ref or resetting the QR timer; never rotate after `creds.me` is set.
- Published npm package contains only compiled `lib/**/*`, `WAProto/**/*`, and `engine-requirements.js`; patch the shipped `lib` files plus package metadata, not upstream TypeScript source files that are absent from npm.
- The patch must add an exact package metadata marker: `pokemonRpgPairingCompatibility: "rc14-companion-reg-refresh-v1"`.
- Bare rc14, missing marker, wrong marker, empty version, and unknown provider versions all remain blocked before PostgreSQL reservation/socket creation.
- CI must not contact the real WhatsApp provider and must never emit QR/auth secrets.
- Runtime normal path remains `allowCreate:false`.
- No Phase 17 weighted checkbox is closed by this work; progress stays 97.40% until real external proof exists.

---

### Task 1: Provider identity becomes version + audited patch marker

**Files:**
- Modify: `src/adapters/whatsapp/baileys-package-version.ts`
- Modify: `src/operations/whatsapp-pairing-bootstrap-cli.ts`
- Modify: `src/operations/whatsapp-pairing-bootstrap.ts`
- Modify: `scripts/operations/bootstrap-whatsapp-session.ts`
- Modify: `tests/runtime/whatsapp-pairing-bootstrap-cli.test.ts`
- Modify: `tests/runtime/whatsapp-pairing-bootstrap.test.ts`

**Interfaces:**
- Produces `InstalledBaileysIdentity = { version: string; pairingCompatibility: string | null }`.
- Produces `resolveInstalledBaileysIdentity(): Promise<InstalledBaileysIdentity>` from installed package metadata.
- Changes `assertWhatsAppPairingProviderVersionSupported` into an identity gate that accepts only `{ version: "7.0.0-rc14", pairingCompatibility: "rc14-companion-reg-refresh-v1" }` for real provider execution.
- `PairingCliExecutor` receives the full provider identity, not a free-form version string.

- [ ] **Step 1: Write RED tests for provider identity**

Add tests proving:

```ts
expect(() => assertWhatsAppPairingProviderIdentitySupported({
  version: "7.0.0-rc14",
  pairingCompatibility: null,
})).toThrow(WhatsAppPairingProviderVersionBlockedError);

expect(() => assertWhatsAppPairingProviderIdentitySupported({
  version: "7.0.0-rc14",
  pairingCompatibility: "wrong-marker",
})).toThrow(WhatsAppPairingProviderVersionBlockedError);

expect(() => assertWhatsAppPairingProviderIdentitySupported({
  version: "7.0.0-rc15",
  pairingCompatibility: null,
})).toThrow(WhatsAppPairingProviderVersionBlockedError);

expect(() => assertWhatsAppPairingProviderIdentitySupported({
  version: "7.0.0-rc14",
  pairingCompatibility: "rc14-companion-reg-refresh-v1",
})).not.toThrow();
```

CLI tests must prove blocked identities never call the pairing executor and the resolver has no env/flag override.

- [ ] **Step 2: Run focused tests and verify RED**

Run in CI/local runner:

```bash
pnpm exec vitest run tests/runtime/whatsapp-pairing-bootstrap.test.ts tests/runtime/whatsapp-pairing-bootstrap-cli.test.ts
```

Expected: fail because the identity type/resolver/gate do not yet exist and current rc14 gate cannot distinguish patched rc14.

- [ ] **Step 3: Implement minimal provider identity gate**

Read package metadata from the installed Baileys package using the existing adapter-local package traversal. Accept only the exact version+marker pair above; keep all other identities fail-closed. Do not inspect environment variables for compatibility.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same Vitest command. Expected: all focused tests pass with zero raw provider material in output.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/whatsapp/baileys-package-version.ts src/operations/whatsapp-pairing-bootstrap-cli.ts src/operations/whatsapp-pairing-bootstrap.ts scripts/operations/bootstrap-whatsapp-session.ts tests/runtime/whatsapp-pairing-bootstrap-cli.test.ts tests/runtime/whatsapp-pairing-bootstrap.test.ts
git commit -m "test: gate pairing on audited Baileys identity"
```

### Task 2: Generate exact pnpm patch against the published rc14 package

**Files:**
- Create: `patches/@whiskeysockets__baileys@7.0.0-rc14.patch`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Temporary during generation only: `.github/workflows/tmp-phase17-generate-baileys-patch.yml` (must be removed before PR review)

**Interfaces:**
- Package metadata after patch contains `pokemonRpgPairingCompatibility: "rc14-companion-reg-refresh-v1"`.
- Patched runtime implements both #2749 and #2765 behaviors in compiled npm `lib` files.
- pnpm lock records the patch path/hash so an unapplied/drifting patch fails installation.

- [ ] **Step 1: Inspect exact published rc14 compiled targets**

On an Ubuntu 24.04 GitHub runner with Node 24.19.0 and pnpm 11.23.0, install with frozen lock and capture only non-secret excerpts around:

```text
node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js -> sendMessageAck
node_modules/@whiskeysockets/baileys/lib/Socket/socket.js -> pair-device QR generation
node_modules/@whiskeysockets/baileys/lib/Utils/companion-reg-client-utils.js -> buildPairingQRData tail
node_modules/@whiskeysockets/baileys/package.json
```

No project secrets are required for this workflow.

- [ ] **Step 2: Create the package patch with pnpm tooling**

Use `pnpm patch @whiskeysockets/baileys@7.0.0-rc14`, modify only:

```text
package.json
lib/Socket/messages-recv.js
lib/Socket/socket.js
lib/Utils/companion-reg-client-utils.js
```

Required compiled behavior:

```js
// messages-recv.js
const stanza = buildAckStanza(node, errorCode, authState.creds.me?.id)
```

```js
// companion-reg-client-utils.js
// add randomBytes import, makePairingQRRenderer(), handleCompanionRegRefresh()
// rotate with randomBytes(32).toString('base64')
// accepted children only: companion_reg_refresh | pair-device-rotate-qr
// registered creds.me => no rotation
```

```js
// socket.js
// read creds.advSecretKey on each render
// retain current ref via renderer
// refresh current QR on CB:notification,type:companion_reg_refresh
// do not advance ref or reset qrTimer for refresh
```

Add package marker:

```json
"pokemonRpgPairingCompatibility": "rc14-companion-reg-refresh-v1"
```

Finish with `pnpm patch-commit <patch-dir>` so package.json/lock/patch are generated by pnpm, not handwritten lock metadata.

- [ ] **Step 3: Remove the temporary generation workflow**

Delete `.github/workflows/tmp-phase17-generate-baileys-patch.yml` after generated files are committed. The final PR must not contain the temporary workflow.

- [ ] **Step 4: Verify deterministic installation**

Run:

```bash
rm -rf node_modules
pnpm install --frozen-lockfile
node -e "const p=require('./node_modules/@whiskeysockets/baileys/package.json'); if(p.pokemonRpgPairingCompatibility!=='rc14-companion-reg-refresh-v1') process.exit(1)"
```

Expected: frozen install succeeds and the exact marker is present.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml patches/@whiskeysockets__baileys@7.0.0-rc14.patch
git commit -m "fix: patch Baileys rc14 first-pairing protocol"
```

### Task 3: Independent regression proof of the patched npm runtime

**Files:**
- Create: `tests/messaging/baileys-pairing-compat.test.ts`
- If needed for a narrow adapter-only probe, modify: `src/adapters/whatsapp/baileys-provider-contracts.ts`

**Interfaces:**
- Tests import the installed patched npm package through the adapter boundary, not copied helper logic.
- Proves pre-login ACK no longer dereferences absent `creds.me`.
- Proves `companion_reg_refresh` rotates ADV secret and re-emits QR with same ref.

- [ ] **Step 1: Write RED behavior tests against unpatched rc14 semantics**

The test harness must route a mocked binary notification through the actual installed Baileys socket/event path, not call a repository reimplementation of the helper. Assert:

```text
initial QR(ref=A, advSecret=S1)
companion_reg_refresh(valid child)
creds.update.advSecretKey = S2 where S2 != S1 and base64-decoded length = 32
next emitted QR uses ref=A and S2
no ref was consumed by refresh
pre-login ACK path resolves without TypeError when creds.me is absent
```

Also assert malformed child does not rotate and a registered session does not rotate.

- [ ] **Step 2: Verify the tests are capable of RED**

Before the patch is applied (or by temporarily disabling `patchedDependencies` in the isolated runner), run:

```bash
pnpm exec vitest run tests/messaging/baileys-pairing-compat.test.ts
```

Expected: fail specifically on the missing refresh behavior and/or pre-login ACK crash. Do not accept import/setup failures as RED.

- [ ] **Step 3: Restore the canonical patch and run GREEN**

With patchedDependencies active:

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run tests/messaging/baileys-pairing-compat.test.ts
```

Expected: all compatibility assertions pass.

- [ ] **Step 4: Re-run existing WhatsApp boundary tests**

```bash
pnpm exec vitest run tests/messaging tests/runtime/whatsapp-pairing-bootstrap.test.ts tests/runtime/whatsapp-pairing-bootstrap-cli.test.ts
```

Expected: all pass, including the existing rule that Baileys SDK imports stay inside `src/adapters/whatsapp`.

- [ ] **Step 5: Commit**

```bash
git add tests/messaging/baileys-pairing-compat.test.ts src/adapters/whatsapp/baileys-provider-contracts.ts
git commit -m "test: prove patched Baileys pairing protocol"
```

### Task 4: Operator contract changes from blocked to staging-eligible

**Files:**
- Modify: `docs/operations/whatsapp-first-pairing.md`
- Modify: `docs/operations/release-recovery-runbook.md`
- Modify: `scripts/operations/verify-operator-docs.ts`
- Modify: `.env.example` only if operator-visible wording needs to distinguish eligibility from proof.

**Interfaces:**
- Documentation says exact patched rc14 is eligible for a real staging pairing attempt.
- Documentation explicitly says CI proof is not provider-live proof.
- Production pairing remains prohibited until the same compatibility patch is first proven in staging and the resulting session/runtime smoke is healthy.

- [ ] **Step 1: Write RED operator-doc verification tokens**

Require the docs to contain:

```text
rc14-companion-reg-refresh-v1
ELIGIBLE_FOR_STAGING_PAIRING
not provider-live proof
WhiskeySockets/Baileys#2749
WhiskeySockets/Baileys#2765
```

- [ ] **Step 2: Run docs verifier and verify RED**

```bash
pnpm ops:docs:verify
```

Expected: failure because the new compatibility contract is not documented yet.

- [ ] **Step 3: Update runbooks with exact scope and rollback**

Document:
- the checked-in patch source/marker;
- staging-only first live acceptance before production;
- success criterion remains real `connection=open`, persisted session, deployed runtime heartbeat and smoke;
- patch removal/upgrade procedure: remove patchedDependencies only after an official release is independently proven to contain equivalent behavior;
- never switch to mutable fork branch as an emergency workaround.

- [ ] **Step 4: Run docs verifier and verify GREEN**

```bash
pnpm ops:docs:verify
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/whatsapp-first-pairing.md docs/operations/release-recovery-runbook.md scripts/operations/verify-operator-docs.ts .env.example
git commit -m "docs: define patched Baileys staging acceptance"
```

### Task 5: Full security/release verification and PR gate

**Files:**
- No intended new production files; fix only evidence-backed failures.

**Interfaces:**
- Final branch is mergeable only if all repository workflows pass.
- No real provider call occurs in CI.

- [ ] **Step 1: Run full local/CI-equivalent checks**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm ops:docs:verify
```

Also run the existing PostgreSQL/WhatsApp proof workflows through the PR.

- [ ] **Step 2: Audit patch scope**

Verify the patch modifies only the four allowed package files and that the final PR contains no temporary workflow, no fork dependency, no mutable Git SHA dependency, no QR/auth sample, and no provider secret.

- [ ] **Step 3: Open PR against freshly revalidated `main`**

PR body must state:
- upstream issues/PRs and exact source heads;
- that official npm latest remains rc14;
- bare rc14 still fails closed;
- patched rc14 is only staging-eligible;
- 17.2/17.3/17.5 remain open;
- progress remains 97.40%.

- [ ] **Step 4: Require all PR workflows SUCCESS**

Do not merge on partial checks. If any workflow fails, inspect the exact failure and fix minimally.

- [ ] **Step 5: Squash merge with expected head SHA and verify `main` push workflows**

After merge, require the canonical push workflows and runtime image publisher to succeed for the merge SHA; record the new OCI digest.

- [ ] **Step 6: Sync Drive without changing weighted progress**

Append the exact merge SHA, tree, patch marker, upstream source heads, CI evidence and image digest to both canonical checkpoint and checklist. Explicitly keep 17.2/17.3/17.5 open and 97.40% unchanged.

- [ ] **Step 7: Real staging acceptance is a separate external gate**

Only after the code merge, execute the local-interactive TTY ceremony against the actual staging DB/session. A successful scan must lead to real `connection=open` and persisted auth. Then deploy the exact image, observe provider `CONNECTED` + fresh heartbeat, and run post-deploy smoke. No CI result substitutes for this external evidence.
