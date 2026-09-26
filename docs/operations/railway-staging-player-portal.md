# Railway staging Player Portal

The Player Portal is a separate HTTP service from the WhatsApp/Baileys worker.

It reuses the same immutable runtime image, but starts:

`node dist/src/player-portal-main.js`

This service does not pair WhatsApp, open a QR code, own a Baileys session, or require the WhatsApp worker to be connected.

## Required staging bootstrap

Create exactly one Railway service in the existing staging project/environment:

- service: `pokemon-rpg-player-portal-staging`
- public HTTPS domain enabled
- `DATABASE_URL` configured for the canonical staging database
- `APP_ENV=staging`
- `PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64` configured as canonical base64 for exactly 32 bytes
- `PORT` may be omitted; Railway supplies it
- do not add `MIGRATOR_DATABASE_URL`

GitHub staging Environment configuration:

- existing secret: `RAILWAY_TOKEN`
- variable: `STAGING_RAILWAY_PLAYER_PORTAL_SERVICE=pokemon-rpg-player-portal-staging`
- variable: `STAGING_PLAYER_PORTAL_URL=https://<public-player-portal-domain>`

The secret values are never printed or copied into repository files.

## Canonical deployment

Workflow: **Railway Staging Player Portal Deploy**

The workflow is fail-closed and only deploys canonical `main`. It:

1. verifies the exact immutable GHCR image revision;
2. resolves the preconfigured Railway service;
3. stages the exact `DEPLOY_REVISION`;
4. wraps the pinned image with the Player Portal command;
5. waits for Railway `SUCCESS`;
6. performs a public unauthenticated smoke against `/v1/hub/player/self`.

A healthy unauthenticated boundary returns HTTP 401 with `{"error":"UNAUTHENTICATED"}`.

## Hub connection

The Hub/Vercel project must set:

`PLAYER_PORTAL_API_BASE_URL=https://<public-player-portal-domain>`

for the environment that should consume this service.

There is no hard-coded preview tunnel fallback. If the variable is absent, the Hub BFF deliberately returns `503 PLAYER_PORTAL_UNAVAILABLE`.

For a production Hub, point this variable only at an explicitly approved Player Portal environment. Do not silently use a temporary Cloudflare tunnel or the WhatsApp worker service as a substitute.
