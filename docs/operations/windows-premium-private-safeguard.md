# Windows Premium — private safety capture before any game update

**Status:** preparation only. This capture creates no deployment, updates no game process, runs no `git checkout/reset/pull/clean`, never calls `pnpm db:migrate`, and does not restart PM2 or Baileys. The local active repository is left unchanged. This is not a complete disaster-recovery rehearsal.

## Why this is necessary

The operator reported a detached local HEAD `19a29bf19cff00d569e81238a47de4c24001bf1f` with 40 tracked modifications and 2 new files. The private Git patch/copies already made are not sufficient to restore PostgreSQL, ignored configuration, actual compiled artifacts, and external WhatsApp encryption material. PR #245 is remotely green but **may not be copied onto the active Windows directory** until its differences are reconciled with those 42 local entries.

The Baileys authentication snapshot in this engine is encrypted and stored in PostgreSQL. A usable restore also requires the external `WHATSAPP_AUTH_KEY_BASE64`, the correct `WHATSAPP_AUTH_KEY_VERSION` and `WHATSAPP_SESSION_KEY`. These secrets may be in an `.env`, PM2's service environment, or another vault; the source archive is NOT proof that the external keys were captured.

## What the safeguard does

`scripts/operations/windows-premium-private-safeguard.ps1` (PowerShell 5.1+) requires the operator to supply:
- `-RepoPath`: the currently active source repository, **not** an arbitrary checkout;
- `-BackupRoot`: an existing **private, local, nonsynced** directory outside the repository;
- PostgreSQL's client `pg_dump` and `pg_restore` available on PATH or explicitly selected by `-PgDumpCommand` and `-PgRestoreCommand`;
- `PGHOST`, `PGUSER` and `PGDATABASE` set privately in the operator's PowerShell process, plus the connection-specific `PGPORT`/`PGPASSWORD`/`PGSSLMODE` or secure `.pgpass` as applicable. Never type credentials into a shell command argument or send them in chat.

The script refuses to create a snapshot if the required environment/tools are missing, the destination is inside the worktree, or the backup root appears synced or is a junction/symlink path. On success it restricts the new directory to the current Windows SID (no inherited grants) **before copying private bytes**, archives the entire current worktree (including `.git`, edited, ignored and dotfiles), creates a PostgreSQL custom dump using only PG environment parameters (no password in command-line arguments), checks the dump catalogue using `pg_restore --list`, computes SHA-256s, and writes a manifest with NO filenames from `git status`, tokens, passwords, connection strings, or private data.

It prints only one redacted JSON status line, and marks the result `CAPTURED_NOT_RESTORED`; `releaseEligible` is **always false**. On failure after the folder was created, it leaves an `INCOMPLETE.txt` marker and preserves already-captured evidence without overwriting another generation. **Do not upload either backup archive, manifest with local context, SQL dump, .env or PM2 environment to chat, Drive, CI, or GitHub.**

## Operator execution (only after confirming the intended DB)

Obtain/review the single `.ps1` file from the immutable GitHub PR code revision in a separate folder (for example Windows Downloads). **Do not checkout the Draft branch into the live bot folder.** Use the correct real source path and a directory with sufficient free space. For example, the backup directory can be created privately in the operator's local AppData. Run the script with PowerShell from the separate folder:

```powershell
$backupRoot = Join-Path $env:LOCALAPPDATA 'PokemonBeyondPrivateBackups'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
# PostgreSQL PG* variables must already be securely configured for the actual live DB.
powershell -NoProfile -ExecutionPolicy Bypass -File '.\windows-premium-private-safeguard.ps1' -RepoPath 'C:\<ACTUAL-BOT-WORKTREE>' -BackupRoot $backupRoot
```

Do not copy commands with placeholder values literally. If the script returns `MISSING_PGHOST`, `REQUIRED_TOOL_UNAVAILABLE`, or another refusal, **do not work around it by using made-up database values**. Resolve the actual operator environment privately.

## Critical gates not supplied by the capture

- **Backup authenticity:** verify the selected `PG*` environment actually targets the correct live DB; a structurally readable custom dump may still be the wrong database.
- **Restore drill:** restore the dump into a separate/disposable PostgreSQL database with `pg_restore --exit-on-error`, compare schema migration history/fingerprint and representative player, wallet, inventory, encounter, in/outbox and admin audit data. The script does not execute that write operation.
- **WhatsApp recovery:** prove that the **external** Baileys encryption key/version/session label are preserved in the existing secret layer and can decrypt the restored session without a second live WhatsApp worker. Do not print or export them to public channels.
- **Runtime recovery:** preserve/reconcile PM2 process configuration and actual running `dist`/service identities, which may reside **outside** the repo, independently of the source archive.
- **Git recovery:** verify the original 40 tracked + 2 untracked changes and the preexisting private patch/copies restore cleanly in a **separate clone**, never via reset/clean on the bot.
- **Application readiness:** ACTIVE catalog audit, release binary vs applied DB migrations, E2E WhatsApp/Hub, deep capture test, approved rollback and PM2 health.

A fully passing GitHub run and a private snapshot are useful evidence but do **not** establish a releasable Windows build. Until these gates pass, keep PRs Draft and the active bot unchanged.

## CI evidence

`.github/workflows/windows-premium-safeguard-proof.yml` executes PowerShell on a disposable GitHub Windows runner. The tests use a throwaway Git worktree and **fake `pg_dump` and `pg_restore` executables**. They verify the script's refusal paths, file/archive layout, inclusion of a fixture `.env`, private ACL, SHA-256 manifests, no Git index writes, no secret in output, and explicit incomplete markers for failed dumps. **Those tests are not evidence that a real PostgreSQL database was backed up or restored.**
