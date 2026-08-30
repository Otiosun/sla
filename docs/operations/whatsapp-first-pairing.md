# WhatsApp first-pairing bootstrap

## Purpose

This procedure creates the first encrypted PostgreSQL-backed Baileys auth session for one staging or production WhatsApp session. It is a one-shot bootstrap ceremony, not a normal runtime path, session-rotation tool or generic auth-repair command.

The normal long-running runtime remains fail-closed and opens auth with creation disabled. It must never silently create or replace a missing session.

## Current provider gate

The repository currently pins `@whiskeysockets/baileys@7.0.0-rc14`.

The first-pairing gate is environment-specific and fail-closed:

- `staging`: rc14 is an explicitly reviewed provider candidate and may reach the real pairing socket;
- `production`: the approved-provider allowlist is intentionally empty, so first pairing remains blocked;
- any unreviewed or unknown Baileys version is blocked in every environment until it is explicitly reviewed and allowlisted.

This staging eligibility is not a compatibility claim. It exists only to permit the real-provider acceptance that is required before any production approval.

Before creating the pairing socket, `pnpm ops:bootstrap:whatsapp` resolves the actual installed Baileys package version, enforces the environment-specific provider allowlist, requires a local interactive terminal, resolves the current WhatsApp Web protocol version through the Baileys adapter, rejects stale/invalid resolution, and passes the resolved protocol tuple explicitly to the socket.

Do not bypass either gate with an environment variable, patched version string, manually supplied WhatsApp Web version or direct database insert. The operator does not choose the provider version or protocol tuple.

Production use becomes eligible only after a real-provider staging acceptance proves the exact provider candidate, protocol resolution, encrypted auth persistence, restart recovery and canonical provider-live smoke. Promotion to production requires a separate explicit allowlist change and its own repository proofs.

## Required conditions

Before running the ceremony:

- use `APP_ENV=staging` for the current provider acceptance; production remains blocked until separately approved;
- identify the exact full 40-character `DEPLOY_REVISION` being prepared;
- configure the restricted runtime `DATABASE_URL` for the target environment;
- configure `WHATSAPP_SESSION_KEY` for exactly one target session;
- configure `WHATSAPP_AUTH_KEY_BASE64` as canonical base64 for exactly 32 random bytes in the secret layer;
- configure the positive `WHATSAPP_AUTH_KEY_VERSION`;
- optionally configure `WHATSAPP_PAIRING_TIMEOUT_MS` (default `120000`, maximum `300000`);
- verify the target database already has the canonical schema and runtime grants;
- stop any runtime process that could use the same `WHATSAPP_SESSION_KEY` so the PostgreSQL advisory lease is free;
- verify the target session has never already been bootstrapped;
- ensure the operator terminal has outbound access required to resolve the current WhatsApp Web protocol version and connect to the WhatsApp provider.

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

From a trusted local operator terminal with the release-bound staging environment configured:

```bash
pnpm ops:bootstrap:whatsapp
```

With the currently pinned rc14, staging is allowed to proceed to real-provider acceptance. Production is expected to stop at the provider-version gate until a separate approval promotes a proven provider version into the production allowlist.

## Pairing ceremony

The command performs these steps in order:

1. validate release environment, runtime database URL, full deployment revision and WhatsApp auth settings;
2. resolve the actual installed Baileys version and enforce the environment-specific provider allowlist;
3. require a local interactive TTY and reject CI/non-interactive execution;
4. resolve and validate the current WhatsApp Web protocol version through the encapsulated Baileys adapter;
5. open a small restricted-runtime PostgreSQL pool and verify the canonical schema;
6. acquire the existing session advisory lease through a create-only bootstrap reservation;
7. create the pairing socket with the resolved WhatsApp Web protocol tuple explicitly configured;
8. keep all first-pairing credentials and Signal keys ephemeral in memory while the QR is displayed locally;
9. wait for actual provider `connection=open` and require registered credentials;
10. atomically persist credentials plus all collected Signal keys as one encrypted PostgreSQL snapshot;
11. close the provider socket, release the reservation/lease and close the database pool.

No auth row is created before provider success. Provider-version rejection, protocol-resolution failure, timeout, provider close, QR-render failure or incomplete registration leaves no partially bootstrapped session.

## After successful staging pairing

A successful QR scan is only one checkpoint. After pairing:

1. do not run the bootstrap command again for that session;
2. start/deploy the normal single-replica staging runtime using the same `WHATSAPP_SESSION_KEY` and encryption key version;
3. require the runtime to recover the existing PostgreSQL auth rather than create a new one;
4. prove restart/recovery using the persisted encrypted session;
5. run the canonical post-deploy smoke;
6. accept provider-live staging readiness only when the expected full SHA/session reports fresh `CONNECTED` heartbeat evidence and `finalPostDeploySmokeComplete=true`;
7. only after that evidence, review a separate production allowlist promotion. Staging success must never silently approve production.

## Failure and recovery

If protocol resolution reports stale/unavailable WhatsApp Web metadata, stop. Do not fall back to a hard-coded or operator-supplied protocol tuple.

If the provider closes during pairing, including HTTP/provider errors such as 408/428, stop and preserve only non-sensitive diagnostics. Do not repeatedly hammer the provider with automated retries.

If the command reports that the auth session already exists, stop. Do not delete the existing session merely to force another QR.

If the advisory lease is unavailable, stop the process holding the same session and verify the target identity before retrying. Do not run two pairing ceremonies or a pairing ceremony plus active runtime for the same session.

If an existing session is lost, corrupt, logged out or cannot be decrypted, treat it as an incident. Preserve evidence and follow `docs/operations/incident-response.md` plus `docs/operations/release-recovery-runbook.md`. Session replacement/rotation requires a separately governed recovery design; this first-pairing command is not that design.
