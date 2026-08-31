# WhatsApp first-pairing bootstrap

## Purpose

This procedure creates the first encrypted PostgreSQL-backed Baileys auth session for the staging WhatsApp identity. It is a one-shot bootstrap ceremony executed by a local operator, not a normal runtime path, session-rotation tool or generic auth-repair command.

The normal long-running runtime remains fail-closed and opens auth with creation disabled. It must never silently create or replace a missing session.

First pairing is **host-agnostic**. It does not require Fly.io, Render, Railway or any other paid runtime host. Hosting is a separate release decision. The staging pairing helper uses the already provisioned Supabase staging database and a short-lived Temporary Access/JIT credential.

## Current provider gate

The repository pins `@whiskeysockets/baileys@7.0.0-rc14` together with the audited pairing compatibility marker `rc14-companion-reg-refresh-v1`.

Live first pairing is eligible only when all of the following are true:

- `APP_ENV=staging`;
- the installed provider identity is exactly `7.0.0-rc14` plus the audited compatibility marker;
- execution is a local interactive TTY, not CI;
- `fetchLatestWaWebVersion()` returns `isLatest=true` and an exact three-integer protocol tuple.

The resolved WhatsApp Web protocol tuple is passed explicitly to the provider socket. There is no environment override and no stale hard-coded fallback.

Production first pairing remains blocked in code until a separate promotion decision is made after real staging evidence. Do not bypass the gate with an environment variable, forged version string or manual database insert.

## Zero-cost staging helper

Use the host-agnostic local helper for the real staging ceremony:

```bash
pnpm ops:bootstrap:whatsapp:staging
```

The helper:

1. requires a clean Git checkout and derives the full `DEPLOY_REVISION` from `HEAD`;
2. requires the versioned `certs/supabase/prod-ca-2021.crt` and keeps TLS at `verify-full`;
3. constructs a Temporary Access/JIT PostgreSQL URL fixed to `pokemon_runtime`;
4. never injects `MIGRATOR_DATABASE_URL` into the pairing process;
5. removes raw JIT configuration and known hosting-provider credentials before spawning the canonical pairing process;
6. creates `.env.whatsapp-staging.local` only when no local auth encryption key exists;
7. stores only the staging session key, the 32-byte auth encryption key and its version in that gitignored local file;
8. never persists the JIT token or database URL;
9. starts the canonical `bootstrap-whatsapp-session.ts` process with inherited terminal input/output so the QR remains local.

`.env.whatsapp-staging.local` matches the repository `.env.*` ignore rule. Keep the file private and retain it after pairing: the same encryption key is required by whichever zero-cost runtime is selected later to decrypt the PostgreSQL-backed WhatsApp session.

## Required conditions

Before running the ceremony:

- use the current clean canonical `main` checkout;
- have Node/pnpm versions required by the repository installed;
- verify the staging database already has the canonical schema, grants and ACTIVE Gen I-III content;
- obtain a fresh short-lived Supabase Temporary Access/JIT token that may assume only `pokemon_runtime` for this ceremony;
- know the staging Supabase project ref and pooler host;
- stop any runtime process that could use the `pokemon-staging` session so the PostgreSQL advisory lease is free;
- verify the target session has never already been bootstrapped.

The helper requires these temporary shell variables:

- `STAGING_SUPABASE_PROJECT_REF` — non-secret staging project ref;
- `STAGING_SUPABASE_POOLER_HOST` — non-secret staging pooler host;
- `STAGING_SUPABASE_JIT_TOKEN` — short-lived secret; keep it out of command history and persistent files.

`WHATSAPP_PAIRING_TIMEOUT_MS` remains optional for the canonical child process; it defaults to `120000` and is capped at `300000`.

Do not inject or use a migrator credential merely to pair WhatsApp.

## Windows PowerShell procedure

From the repository root in a trusted local PowerShell terminal, set the two non-secret values for the current shell:

```powershell
$env:STAGING_SUPABASE_PROJECT_REF = "<staging-project-ref>"
$env:STAGING_SUPABASE_POOLER_HOST = "<staging-pooler-host>"
```

Read the JIT token without placing the plaintext token in PowerShell history. This form works on Windows PowerShell 5.1 and PowerShell 7:

```powershell
$secure = Read-Host "Supabase JIT token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:STAGING_SUPABASE_JIT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

Then execute:

```powershell
pnpm ops:bootstrap:whatsapp:staging
```

If no local WhatsApp encryption key exists yet, the helper creates `.env.whatsapp-staging.local` without printing the key. Do not open, paste, upload or commit that file.

As soon as the temporary token is no longer needed, remove it from the shell:

```powershell
Remove-Item Env:STAGING_SUPABASE_JIT_TOKEN -ErrorAction SilentlyContinue
```

## QR scan

When the terminal displays the QR:

1. open WhatsApp on the phone that will own the bot session;
2. open **Aparelhos conectados / Linked devices**;
3. choose **Conectar aparelho / Link a device**;
4. scan the QR directly from the terminal.

Do not paste, screenshot, record or forward the QR into chat, GitHub, Drive, logs or another persistent artifact. Treat it as short-lived authentication material.

## Successful ceremony

The canonical pairing command performs these steps in order:

1. validate staging runtime configuration and the exact release revision;
2. resolve the actually installed Baileys package identity and enforce the audited staging-only provider gate;
3. require a local interactive TTY and reject CI/non-interactive execution;
4. resolve and validate the current WhatsApp Web protocol version;
5. open a small restricted-runtime PostgreSQL pool and verify the canonical schema;
6. acquire the session advisory lease through a create-only bootstrap reservation;
7. keep all first-pairing credentials and Signal keys ephemeral in memory while the QR is displayed locally;
8. wait for actual provider `connection=open` and require registered credentials;
9. atomically persist credentials plus all collected Signal keys as one encrypted PostgreSQL snapshot;
10. close the provider socket, release the reservation/lease and close the database pool.

No auth row is created before provider success. Timeout, provider close, QR-render failure, stale protocol resolution or incomplete registration leaves no partially bootstrapped session.

## After success

After a successful first pairing:

1. do not run the bootstrap command again for that session;
2. remove the short-lived JIT token from the shell;
3. retain `.env.whatsapp-staging.local` privately; never commit or upload it;
4. verify the encrypted PostgreSQL auth session exists;
5. choose/provision the long-running runtime separately under the project's R$0 hosting constraint;
6. configure that runtime with the same `WHATSAPP_SESSION_KEY`, auth encryption key and key version so it can recover the existing PostgreSQL session rather than create a new one;
7. run the canonical provider-live/post-deploy smoke after the runtime is actually connected;
8. accept final provider-live readiness only when the expected revision/session has a fresh CONNECTED heartbeat and `finalPostDeploySmokeComplete=true`.

A successful QR scan alone is not final release evidence.

## Failure and recovery

If the command reports that the auth session already exists, stop. Do not delete the existing session merely to force another QR.

If the advisory lease is unavailable, stop the process holding the same session and verify the target identity before retrying. Do not run two pairing ceremonies or a pairing ceremony plus active runtime for the same session.

If the provider closes with a transient or server-side pairing error such as 408/428, stop and preserve only the sanitized error classification. Do not hammer repeated pairing attempts.

If an existing session is lost, corrupt, logged out or cannot be decrypted, treat it as an incident. Preserve evidence and follow `docs/operations/incident-response.md` plus `docs/operations/release-recovery-runbook.md`. Session replacement/rotation requires a separately governed recovery design; this first-pairing command is not that design.
