# WhatsApp first-pairing bootstrap

## Purpose

This procedure creates the first encrypted PostgreSQL-backed Baileys auth session for one staging or production WhatsApp session. It is a one-shot bootstrap ceremony, not a normal runtime path, session-rotation tool or generic auth-repair command.

The normal long-running runtime remains fail-closed and opens auth with creation disabled. It must never silently create or replace a missing session.

## Current provider gate

The repository currently pins `@whiskeysockets/baileys@7.0.0-rc14`. That version is intentionally blocked for live first pairing because the currently known upstream registration path is not trusted for this release.

`pnpm ops:bootstrap:whatsapp` therefore resolves the actual installed Baileys package version and rejects rc14 before PostgreSQL reservation or provider socket creation. Do not bypass this gate with an environment variable, patched version string or manual database insert.

Live use becomes eligible only after an approved Baileys upgrade or separately reviewed provider patch passes the repository pairing proofs and an explicit real-provider staging acceptance.

## Required conditions

Before running the ceremony:

- use only `APP_ENV=staging` or `APP_ENV=production`;
- identify the exact full 40-character `DEPLOY_REVISION` being prepared;
- configure the restricted runtime `DATABASE_URL` for the target environment;
- configure `WHATSAPP_SESSION_KEY` for exactly one target session;
- configure `WHATSAPP_AUTH_KEY_BASE64` as canonical base64 for exactly 32 random bytes in the secret layer;
- configure the positive `WHATSAPP_AUTH_KEY_VERSION`;
- optionally configure `WHATSAPP_PAIRING_TIMEOUT_MS` (default `120000`, maximum `300000`);
- verify the target database already has the canonical schema and runtime grants;
- stop any runtime process that could use the same `WHATSAPP_SESSION_KEY` so the PostgreSQL advisory lease is free;
- verify the target session has never already been bootstrapped.

Do not inject `MIGRATOR_DATABASE_URL` merely to pair WhatsApp. The ceremony uses the restricted runtime database identity after migrations/grants are already complete.

## Sensitive-output rules

The ceremony is local-interactive only:

- both stdin and stdout must be a TTY;
- execution is blocked when `CI` is present;
- the QR payload is passed only in memory to the terminal renderer;
- the renderer is used in callback mode so the library does not print the raw payload itself;
- ordinary structured logs, error strings, CI artifacts, Drive documents and GitHub issues must never contain the raw QR or auth material.

Do not paste, screenshot, record or forward the QR into chat, an issue, Drive, a CI log or another persistent artifact. Treat it as short-lived authentication material.

## Command

From a trusted local operator terminal with the release-bound environment configured:

```bash
pnpm ops:bootstrap:whatsapp
```

With the currently pinned rc14 this command is expected to stop at the provider-version gate. That is correct behavior and is not a reason to bypass the gate.

## Successful ceremony after provider compatibility is approved

The command performs these steps in order:

1. validate release environment, runtime database URL, full deployment revision and WhatsApp auth settings;
2. resolve the actual installed Baileys version and enforce the provider-version gate;
3. require a local interactive TTY and reject CI/non-interactive execution;
4. open a small restricted-runtime PostgreSQL pool and verify the canonical schema;
5. acquire the existing session advisory lease through a create-only bootstrap reservation;
6. keep all first-pairing credentials and Signal keys ephemeral in memory while the QR is displayed locally;
7. wait for actual provider `connection=open` and require registered credentials;
8. atomically persist credentials plus all collected Signal keys as one encrypted PostgreSQL snapshot;
9. close the provider socket, release the reservation/lease and close the database pool.

No auth row is created before provider success. Timeout, provider close, QR-render failure or incomplete registration leaves no partially bootstrapped session.

## After success

After a successful first pairing:

1. do not run the bootstrap command again for that session;
2. start/deploy the normal single-replica runtime using the same `WHATSAPP_SESSION_KEY` and encryption key version;
3. require the runtime to recover the existing PostgreSQL auth rather than create a new one;
4. run the canonical post-deploy smoke;
5. accept provider-live readiness only when the expected full SHA/session reports fresh `CONNECTED` heartbeat evidence and `finalPostDeploySmokeComplete=true`.

A successful QR scan alone is not release evidence.

## Failure and recovery

If the command reports that the auth session already exists, stop. Do not delete the existing session merely to force another QR.

If the advisory lease is unavailable, stop the process holding the same session and verify the target identity before retrying. Do not run two pairing ceremonies or a pairing ceremony plus active runtime for the same session.

If an existing session is lost, corrupt, logged out or cannot be decrypted, treat it as an incident. Preserve evidence and follow `docs/operations/incident-response.md` plus `docs/operations/release-recovery-runbook.md`. Session replacement/rotation requires a separately governed recovery design; this first-pairing command is not that design.
