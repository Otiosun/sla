# Pokémon Beyond — Gate F5 / Staging Premium: isolation checkpoint

> 19–20/10/2026. This is a **read-only infrastructure diagnosis** and cutover checklist, not permission to deploy, enable Premium, migrate a real DB, touch WhatsApp or change the operator's computer.

## Result observed via Railway connector (no secrets read/published)

Project: `wonderful-creativity`, staging environment `4c44d875-2018-4859-a7cc-20ed445b5468`.

| Existing service | Latest deployment | Runtime state |
| --- | --- | --- |
| `pokemon-rpg-player-api-staging-v2` | FAILED, 11/09 | Offline |
| `pokemon-rpg-player-api-staging` | FAILED, 11/09 | Offline |
| `pokemon-rpg-player-api-rc` | FAILED, 22/09 | Offline |
| `pokemon-rpg-player-api-rc-current` | FAILED, 23/09 | Offline |
| `pokemon-rpg-whatsapp-staging` | No latest deployment | Offline |

Four API services have a `DATABASE_URL` variable; the Railway OAuth connector returns **names only**, not URL destinations. No PostgreSQL service, volume, bucket or staging shared variable was listed inside this Railway environment. The Railway *production* environment in this project also lists no services. These observations **do not prove** where the existing database is hosted; it may be external. Never infer isolation from the environment name or variable name. Worker staging still has a parked/no-op start command and must not be activated.

The backend Player Portal API already exists. The problem is secure staging, not constructing another API.

## Discovered Supabase project, read-only (19/10)

Connected Supabase project metadata lists exactly one named Pokémon staging project:

- Name: `pokemon-rpg-staging-rc`
- Provider ref: `rfskcoaoppfrcdmqtvvj` (public instance identifier, **not** a password)
- Region: `sa-east-1`
- Status: **INACTIVE**; no database development branches listed
- Organization plan: **free**. This does **not** guarantee that restarting the project has no side effects or that quotas will remain available.

The other visible Supabase project is `reader-platform` and is unrelated. Neither provider listing nor the Railway OAuth connector exposed the **actual Railway DATABASE_URL destination**, so the identity of the Railway DB remains unproven. The GitHub staging environment variable/secret list was not accessible through the available GitHub repository connector; we did **not** request or print credentials.

### Premium activation preflight in bot PR #229

`src/runtime/premium-staging-database-target.ts` now pins the known Pokémon staging ref as a **pre-connection parser gate**. When `APP_ENV=staging` and `PREMIUM_STAGING_ENABLED=1`, the startup loader refuses Premium unless the **actual** app configuration has a PostgreSQL URL using:

- Direct `db.<ref>.supabase.co:5432/postgres`, user `pokemon_runtime`; or
- Shared Supabase **session** pooler `aws-<index>-sa-east-1.pooler.supabase.com:5432/postgres`, username `pokemon_runtime.<ref>`.
- Exactly one `sslmode=verify-full` parameter. Rejects `postgres`, migrator or unrelated roles, another project ref, cross-region pooler, non-5432 ports (including transaction pooler), malformed connection URLs and absent app DB.

The check deliberately never logs the URL. It protects the Premium opt-in but **cannot prove** real role grants, connection authenticity, data exclusivity, valid TLS certificates, or the identity of any preexisting external Railway endpoint. The provider DB is currently inactive; **do not wake it or provision passwords** just to satisfy this gate. The separate role/instance/grant audit and operator cost approval remain required.

## Current code evidence

- Bot PR #229 (stacked above #227) has the commercial `MASTER` owner-only, stage-gated executor.
- `APP_ENV=staging` and `PREMIUM_STAGING_ENABLED=1` are both required for the composed runtime to mount Premium.
- Old paid-order creation and `approve/deliver` HTTP routes are now disabled by default behind `allowLegacyPremiumOrders`; the composed runtime does **not** opt in. The old flow remains available only to explicitly configured historical/disposable test fixtures.
- Web PR #108 (stacked above #107/#106) uses a separate staged session cookie and proxy allowlist. The web proxy now rejects the obsolete paid-order creation and financial approval/delivery endpoints. It preserves manual grants and read-only support/ledger routes.
- Vercel preview-only `VITE_PREMIUM_STAGING_UI=1` and `VITE_PREMIUM_STAGING_TARGET=preview` were scoped to **web PR #108's branch**, not production. These are UI flags, **not a backend activation**. Server flags `PREMIUM_STAGING_ENABLED`, `PREMIUM_STAGING_API_BASE_URL` and `PREMIUM_STAGING_APPROVED_ORIGIN` have not been provisioned.
- The existing GitHub Actions Premium Core disposable PostgreSQL gate is the only verified full Master Ball inventory grant. Its synthetic catalog record does **not** establish that a real staging release publishes the `master-ball` slug.

## Hard gates before any hosted staging activation

1. **Written identity proof of exclusive database:** identify the staging PostgreSQL **cluster/instance ID**, database ID/name and DB role, and compare them against the production source using provider metadata or sanitized fingerprints; **do not display URLs, host credentials or dumps**. A distinct database name alone is insufficient if the staging role can write production. Confirm network permissions and role grants, preferably separate project/instance and read/write credentials usable only there. No production DB connections from staging, including migrations.
2. **Synthetic data only:** create separate owner/player synthetic identities and stage-only signing key, not live IDs, sessions or WhatsApp credentials. Keep staging WhatsApp workers, schedulers, webhooks and background jobs disabled.
3. **Costs:** no new database, service, paid resource, persistent disk or active Railway deployment until the owner explicitly approves its potential cost.
4. **No real migration without authorization:** require backup/restore evidence, contiguous 0001–0077 migrations, review special role/capability change in 0072 and rollback plan. Never point a migrator at an unverified `DATABASE_URL`.
5. **Master Ball catalog gate:** query the release's published item catalog and require **exactly one** active `master-ball` entry; missing/duplicate must show `available=false` and POST must return a refusal, not seed a guessed item or substitute `poke-ball`.
6. **Stage proxy:** configure its HTTPS upstream **only** after DB and keys are proven isolated. Vercel proxy server flags must remain missing/OFF until then; never point at `pokemon-api.otiosunbots.xyz`.
7. **End-to-end acceptance:** test 401/403/no owner, stage cookie separation, anti-CSRF, idempotent Master grant twice (one inventory change), race/error replay, zero payment/financial event, other packs stay pending, Android/desktop authenticated QA, rollback.
8. **Production remains unchanged:** no merge of stacked draft PRs, promotion or local bot deployment during F5. Before touching the user's local PC, installing, migrating, restarting or changing WhatsApp authentication, notify the operator and obtain explicit authorization.

## Status

**BLOCKED for hosted staging** on independent DB/owner/key proof. Do not wake an old failed API merely because its name contains `staging`. Disposable CI tests may continue without the local bot, live data, or paid hosting.
