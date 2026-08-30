#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '{"event":"staging.database.jit.rejected","reason":"%s"}\n' "$1" >&2
  exit 64
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "missing_${name}"
  fi
}

require_env APP_ENV
require_env DEPLOY_REVISION
require_env STAGING_SUPABASE_PROJECT_REF
require_env STAGING_SUPABASE_POOLER_HOST
require_env STAGING_SUPABASE_JIT_TOKEN

[[ "$APP_ENV" == "staging" ]] || fail "APP_ENV_must_be_staging"
[[ "$DEPLOY_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "DEPLOY_REVISION_must_be_full_commit_sha"
[[ "$STAGING_SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || fail "invalid_supabase_project_ref"
[[ "$STAGING_SUPABASE_POOLER_HOST" =~ ^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$ ]] || fail "invalid_supabase_pooler_host"
command -v node >/dev/null 2>&1 || fail "node_not_available"

make_jit_url() {
  local role="$1"
  ROLE="$role" node --input-type=module -e '
    const role = process.env.ROLE;
    const projectRef = process.env.STAGING_SUPABASE_PROJECT_REF;
    const poolerHost = process.env.STAGING_SUPABASE_POOLER_HOST;
    const token = process.env.STAGING_SUPABASE_JIT_TOKEN;
    if (!role || !projectRef || !poolerHost || !token) process.exit(64);

    const url = new URL("postgresql://placeholder@localhost/postgres");
    url.username = `${role}.${projectRef}`;
    url.password = token;
    url.hostname = poolerHost;
    url.port = "5432";
    url.pathname = "/postgres";
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("options", "-c jit=true");
    process.stdout.write(url.toString());
  '
}

owner_url="$(make_jit_url postgres)"
migrator_url="$(make_jit_url pokemon_migrator)"
runtime_url="$(make_jit_url pokemon_runtime)"

# GitHub Actions masks both the source PAT and derived credential-bearing URLs before any child
# command can report them. They only live in this process tree and are never written to a file.
printf '::add-mask::%s\n' "$STAGING_SUPABASE_JIT_TOKEN"
printf '::add-mask::%s\n' "$owner_url"
printf '::add-mask::%s\n' "$migrator_url"
printf '::add-mask::%s\n' "$runtime_url"

APP_ENV=staging \
DEPLOY_REVISION="$DEPLOY_REVISION" \
STAGING_ROLE_BOOTSTRAP_MODE=existing_roles \
STAGING_DATABASE_OWNER_URL="$owner_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
DATABASE_URL="$runtime_url" \
  bash scripts/operations/staging-database-release.sh

if [[ "${RUN_APPLICATION_SMOKE:-false}" == "true" ]]; then
  require_env WHATSAPP_SESSION_KEY
  APP_ENV=staging \
  DEPLOY_REVISION="$DEPLOY_REVISION" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  DATABASE_URL="$runtime_url" \
  WHATSAPP_SESSION_KEY="$WHATSAPP_SESSION_KEY" \
    pnpm --silent run ops:smoke:application
fi

printf '{"event":"staging.database.jit.complete","revision":"%s"}\n' "$DEPLOY_REVISION"
