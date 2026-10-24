# Premium Windows — private worktree inventory (read-only)

This is an **inventory, not a backup or deployment procedure**. It complements the distinct PR #232 `premium-local-readiness.mjs`, which expects a clean worktree and is not meant to classify the existing 40 tracked + 2 untracked local changes.

## Strict use boundary

- The script reads only Git HEAD, symbolic branch and porcelain worktree metadata. It does **not** read or display file contents, filenames, folder paths, credentials, PM2 state, `dist`, PostgreSQL, WhatsApp/Baileys sessions or private backup artifacts.
- It runs `git --no-optional-locks` with `GIT_OPTIONAL_LOCKS=0` and file-monitor/untracked-cache disabled, to avoid Git index-refresh writes. No `git checkout`, `reset`, `clean`, `pull`, `fetch`, `add`, `commit`, build or migration.
- **Do not copy or check out a new branch into the active Windows bot directory just to run this script.** Use a reviewed script from a **separate external checkout**, directing it at the intended worktree by the explicit `--repo` argument.
- No database or provider access is possible through this tool; `releaseEligible` is always `false`. This tool cannot attest that the private Git patch is complete, the database/session are recoverable, that PM2 is running the expected `dist`, or that the ACTIVE catalog is correct.

## Invocation by the operator when allowed

From a safe, separate inspection checkout containing this reviewed file, with Node 24+ and Git available:

```powershell
node "C:\<safe-inspection-checkout>\scripts\operations\premium-worktree-readonly-inventory.mjs" --repo "C:\<intended-active-worktree>"
```

The output is a single **redacted JSON summary**: HEAD SHA, detached status, comparison with the historically observed base `19a29bf19cff00d569e81238a47de4c24001bf1f398`, total tracked/untracked, staged/unstaged/unmerged counts, and aggregate counts by major directory. The output never lists individual paths. Even sharing this summary is optional; never share `.env`, Baileys credentials, backups, raw `pm2 jlist`, Git patch contents, connection strings, or production database dumps.

The historical 42-entry count is **not a requirement to force**. If a later inspection differs, investigate the change against the private safeguard without using reset/clean/rebase in production.

## Independent gates before any cutover

1. Verify the private Git safeguard can restore tracked and untracked differences into a separate clone, without exposing content in chat or public CI.
2. Preserve the actual PostgreSQL database and demonstrate a validated restore into a replacement/disposable database. Git patches are not database backups.
3. Preserve the WhatsApp/Baileys session, ignored configuration and required local `dist`/assets securely, with sensitive material kept out of Git/CI.
4. Resolve the exact deployed binary, PM2 worker identities and runtime flags without printing secrets.
5. Compare private local source differences to #241, #242, #243 and #232 function-by-function. Do not overwrite the 40 tracked/2 untracked entries.
6. Audit ACTIVE catalog with approved read-only database credentials, run the remaining E2E tests, approve rollback and only then consider staging/local cutover.

**Never interpret a successful inventory or a green remote CI as permission to deploy.**
