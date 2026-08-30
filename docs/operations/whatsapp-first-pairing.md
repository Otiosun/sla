# WhatsApp first-pairing bootstrap

## Purpose

This procedure creates the first encrypted PostgreSQL-backed Baileys auth session for staging. It is a one-shot bootstrap ceremony, not a normal runtime path, session-rotation tool or generic auth-repair command.

The normal long-running runtime remains fail-closed and opens auth with creation disabled. It must never silently create or replace a missing session.

## Current provider gate

The repository pins `@whiskeysockets/baileys@7.0.0-rc14` and carries the repository-owned audited first-pairing compatibility patch identified by `rc14-companion-reg-refresh-v1`.

First pairing is intentionally environment-specific:

- **staging** may proceed only when the actually installed provider identity is exactly `7.0.0-rc14` plus `rc14-companion-reg-refresh-v1`;
- **production** remains blocked in code until a separate post-staging approval explicitly promotes a proven provider identity;
- bare rc14, a wrong/missing compatibility marker, another Baileys version or any unknown identity fails closed before PostgreSQL reservation or provider socket creation.

This staging eligibility is not a live-compatibility claim. It exists so the exact audited candidate can undergo real-provider acceptance without implicitly authorizing production.

## WhatsApp Web protocol gate

After provider identity and local-terminal checks pass, the bootstrap resolves the current WhatsApp Web protocol version through the encapsulated Baileys adapter.

The resolver must return `isLatest=true` and exactly three non-negative safe-integer version parts. Stale, invalid or unavailable metadata fails closed. There is no fallback to a hard-coded tuple and no operator-controlled `WHATSAPP_WEB_VERSION` authority.

The validated tuple is passed explicitly as the pairing socket `version` before the provider connection starts.

## Required conditions

Before running the ceremony:

- use `APP_ENV=staging`; the current production pairing gate is intentionally closed;
- identify the exact full 40-character `DEPLOY_REVISION` being prepared;
- configure the restricted runtime `DATABASE_URL` for staging;
- configure `WHATSAPP_SESSION_KEY` for exactly one staging session;
- configure `WHATSAPP_AUTH_KEY_BASE64` as canonical base64 for exactly 32 random bytes in the secret layer;
- configure the positive `WHATSAPP_AUTH_KEY_VERSION`;
- optionally configure `WHATSAPP_PAIRING_TIMEOUT_MS` (default `120000`, maximum `300000`);
- verify the target database already has the canonical schema and runtime grants;
- stop any runtime process that could use the same `WHATSAPP_SESSION_KEY` so the PostgreSQL advisory lease is free;
- verify the target session has never already been bootstrapped;
- ensure the trusted operator terminal can reach the WhatsApp provider and resolve the current WhatsApp Web metadata.

Do not inject `MIGRATOR_DATABASE_URL` merely to pair WhatsApp. The ceremony uses the restricted runtime database identity after migrations/grants are already complete.

## Sensitive-output rules

The ceremony requires a local interactive TTY:

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

Production is expected to stop at the environment/provider gate until a separately reviewed promotion changes that policy.

## Pairing ceremony

The command performs these steps in order:

1. validate staging environment, runtime database URL, full deployment revision and WhatsApp auth settings;
2. resolve the actually installed Baileys identity and require exact rc14 plus the audited compatibility marker;
3. enforce the staging-only provider gate;
4. require a local interactive TTY and reject CI/non-interactive execution;
5. resolve and validate the current WhatsApp Web protocol tuple;
6. open a small restricted-runtime PostgreSQL pool and verify the canonical schema;
7. acquire the existing session advisory lease through a create-only bootstrap reservation;
8. create the provider socket with the validated WhatsApp Web version explicitly configured;
9. keep all first-pairing credentials and Signal keys ephemeral in memory while the QR is displayed locally;
10. wait for actual provider `connection=open` and require registered credentials;
11. atomically persist credentials plus all collected Signal keys as one encrypted PostgreSQL snapshot;
12. close the provider socket, release the reservation/lease and close the database pool.

Provider-identity rejection, production use, protocol-resolution failure, timeout, provider close, QR-render failure or incomplete registration leaves no partially bootstrapped session.

## After successful staging pairing

A successful QR scan alone is not release evidence. After pairing:

1. do not run the bootstrap command again for that session;
2. start/deploy the normal single-replica staging runtime using the same `WHATSAPP_SESSION_KEY` and encryption key version;
3. require the runtime to recover the existing PostgreSQL auth rather than create a new one;
4. prove restart/recovery using the persisted encrypted session;
5. run the canonical post-deploy smoke;
6. accept provider-live staging readiness only when the expected full SHA/session reports fresh `CONNECTED` heartbeat evidence and `finalPostDeploySmokeComplete=true`;
7. only after that evidence may a separate change be reviewed to promote an exact provider identity for production.

Staging success must never silently authorize production.

## Failure and recovery

If current WhatsApp Web metadata cannot be resolved or is reported stale, stop. Do not substitute a manual protocol version.

If the provider closes during pairing, including provider/HTTP failures such as 408 or 428, stop and preserve only non-sensitive diagnostics. Do not repeatedly hammer the provider with automated pairing retries.

If the command reports that the auth session already exists, stop. Do not delete the existing session merely to force another QR.

If the advisory lease is unavailable, stop the process holding the same session and verify the target identity before retrying. Do not run two pairing ceremonies or a pairing ceremony plus active runtime for the same session.

If an existing session is lost, corrupt, logged out or cannot be decrypted, treat it as an incident. Preserve evidence and follow `docs/operations/incident-response.md` plus `docs/operations/release-recovery-runbook.md`. Session replacement/rotation requires a separately governed recovery design; this first-pairing command is not that design.
