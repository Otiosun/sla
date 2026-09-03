# Pokémon Control Center Core — Local Run

This runbook is for development on a local machine only. It does not describe staging or production deployment.

## Frozen source snapshots

Backend source baseline: `85224bc5e6646be5b64fd24a469d81885cf9b04e`.
Frontend source baseline: `4ba17184afefba7b90dbca6ffb5386066be496dc`.
F8.4 is shelved and is not part of the local Core baseline.

## Toolchain

- Node.js 24.19.0
- pnpm 11.23.0
- PostgreSQL reachable on loopback

## Backend startup order

1. Create a local PostgreSQL database and a development `.env` from `.env.example`.
2. Install dependencies with pnpm 11.23.0.
3. Run `pnpm db:migrate`.
4. Run `pnpm db:seed:phase12` to reconcile canonical roles/capabilities.
5. Start the backend with `pnpm dev` only after local admin authentication/bootstrap support is present on the local-run prep branch.

The frozen Core backend intentionally requires Cloudflare Access when Admin API is enabled. Do not fake Access headers or weaken the frozen branch. The local-run prep branch will add an explicit development-only loopback boundary instead.

## Frontend

Use the frontend Core snapshot and `control-center/.env.example`:

```text
VITE_CONTROL_CENTER_ENV=development
VITE_CONTROL_CENTER_API_BASE_URL=http://localhost:8787
VITE_CONTROL_CENTER_BUILD_LABEL=local
```

Install and start from `control-center`:

```powershell
corepack enable
corepack prepare pnpm@11.23.0 --activate
node scripts/materialize-lockfile.mjs
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

The Vite URL is printed by the dev server. The browser must never supply principal, roles, capabilities, scopes, environment or correlation authority.

## Smoke target

When the local development auth boundary is complete, the minimum smoke is:

1. Open the Vite URL.
2. Session gate resolves a real local PostgreSQL admin principal.
3. `Hoje` loads.
4. Player 360 search returns a controlled local fixture/seed result when data exists.
5. Content Library opens read-only.
6. Runtime/messaging/incident cards may legitimately show empty states on a local DB.
7. No simulate/confirm/approve/apply route exists.

## Stop condition

Until the local-development auth/bootstrap work is proven by CI, the frozen Core should be treated as preserved code, not as a one-command local app.
