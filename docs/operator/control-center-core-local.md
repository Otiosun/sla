# Control Center Core — Local Windows Runbook

This runbook starts the frozen Control Center Core locally for development/testing. It does not deploy, merge, or enable the local trust boundary outside loopback development.

## 1. Prerequisites

- Node.js `24.19.0`
- pnpm `11.23.0`
- PostgreSQL running locally
- Backend repository `Otiosun/sla`
- Frontend repository `Otiosun/pokemon-hub-web`

Use only a local PostgreSQL database for this flow. `ADMIN_LOCAL_DEV_PRINCIPAL_ID` is rejected outside `APP_ENV=development` and loopback API/browser addresses.

## 2. Backend checkout and dependencies

In PowerShell:

```powershell
cd <PASTA_DO_SLA>
git fetch origin
git switch prep/control-center-core-local-2026-09-03
git pull --ff-only
pnpm install --frozen-lockfile
```

If `pnpm` is not installed yet:

```powershell
npm install --global pnpm@11.23.0
```

Confirm versions:

```powershell
node --version
pnpm --version
```

Expected Node: `v24.19.0`. Expected pnpm: `11.23.0`.

## 3. Local PostgreSQL database

Create a local database named `pokemon_rpg` if it does not already exist. With the default PostgreSQL administrator role:

```powershell
psql -U postgres -h localhost -c "CREATE DATABASE pokemon_rpg;"
```

If PostgreSQL reports that `pokemon_rpg` already exists, keep the existing local database.

## 4. Bootstrap `.env` before enabling the Admin API

Create `sla/.env` with a local password substituted for `<SENHA_POSTGRES>`:

```dotenv
APP_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgresql://postgres:<SENHA_POSTGRES>@localhost:5432/pokemon_rpg
MIGRATOR_DATABASE_URL=postgresql://postgres:<SENHA_POSTGRES>@localhost:5432/pokemon_rpg
ADMIN_API_ENABLED=false
```

Using the PostgreSQL owner credential for both URLs is a local-development convenience only. Do not reuse this layout in staging or production.

Run migrations and verify the schema:

```powershell
pnpm db:migrate
pnpm db:verify
```

## 5. Create/reuse the local administrative principal

Run:

```powershell
pnpm ops:bootstrap:admin:local
```

The command prints one JSON line containing `principalId` and an `env.ADMIN_LOCAL_DEV_PRINCIPAL_ID` value. Save that UUID. Re-running the command is idempotent and returns the same principal while it remains ACTIVE.

Now replace `.env` with:

```dotenv
APP_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgresql://postgres:<SENHA_POSTGRES>@localhost:5432/pokemon_rpg
MIGRATOR_DATABASE_URL=postgresql://postgres:<SENHA_POSTGRES>@localhost:5432/pokemon_rpg
ADMIN_API_ENABLED=true
ADMIN_API_HOST=127.0.0.1
ADMIN_API_PORT=8787
ADMIN_API_ALLOWED_ORIGIN=http://localhost:5173
ADMIN_LOCAL_DEV_PRINCIPAL_ID=<UUID_RETORNADO_PELO_BOOTSTRAP>
```

Do not add Cloudflare Access variables in this local-only mode.

## 6. Start the backend

Keep this PowerShell window open:

```powershell
pnpm dev
```

The Admin API must bind only to `127.0.0.1:8787`.

Optional port check in another PowerShell window:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen
```

## 7. Frontend checkout and dependencies

Open another PowerShell window:

```powershell
cd <PASTA_DO_POKEMON_HUB_WEB>
git fetch origin
git switch prep/control-center-core-local-2026-09-03
git pull --ff-only
pnpm install --frozen-lockfile
```

The Control Center already has the expected local frontend variables:

```dotenv
VITE_CONTROL_CENTER_ENV=development
VITE_CONTROL_CENTER_API_BASE_URL=http://localhost:8787
VITE_CONTROL_CENTER_BUILD_LABEL=local
```

Materialize/install the isolated Control Center workspace if the root install did not already do it:

```powershell
node control-center/scripts/materialize-lockfile.mjs
pnpm --dir control-center install --frozen-lockfile --ignore-scripts
```

## 8. Start the Control Center

```powershell
pnpm --dir control-center dev
```

Open:

`http://localhost:5173`

The browser supplies no role, capability, scope, principal, or environment authority. The backend resolves the configured local principal from PostgreSQL.

## 9. First smoke check

Confirm all of the following:

1. Frontend opens at `http://localhost:5173`.
2. Backend is listening only at `127.0.0.1:8787`.
3. The shell loads without a Cloudflare Access login prompt.
4. Player 360 / content / operational read surfaces open without an authentication error.
5. No privileged apply/confirm/approve endpoint becomes available.

A brand-new local database has no live production players. Empty Player 360/search results are expected until local/demo data exists or the bot is later pointed at the same local database.

## 10. Stop

Press `Ctrl+C` in the frontend and backend PowerShell windows. PostgreSQL may remain running for later local sessions.

## Safety invariants

- Never change `ADMIN_API_HOST` from loopback while local auth is enabled.
- Never use the local bootstrap against a remote PostgreSQL host.
- Never copy the local principal UUID into staging/production configuration.
- Never expose browser-supplied authority.
- HTTP remains READ + PREPARE ONLY.
- No production deployment or merge is part of this runbook.
