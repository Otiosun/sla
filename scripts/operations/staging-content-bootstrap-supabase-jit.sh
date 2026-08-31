#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '{"event":"staging.content.jit.rejected","reason":"%s"}\n' "$1" >&2
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

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
database_ssl_root_cert_file="${DATABASE_SSL_ROOT_CERT_FILE:-${repo_root}/certs/supabase/prod-ca-2021.crt}"
[[ -f "$database_ssl_root_cert_file" ]] || fail "database_ssl_root_cert_file_not_found"
export NODE_EXTRA_CA_CERTS="$database_ssl_root_cert_file"

runtime_url="$(ROLE=pokemon_runtime node --input-type=module -e '
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
  // Temporary Access requires `-c jit=true`; verify-full preserves hostname and CA verification.
  url.search = "?sslmode=verify-full&options=-c%20jit%3Dtrue";
  process.stdout.write(url.toString());
')"

printf '::add-mask::%s\n' "$STAGING_SUPABASE_JIT_TOKEN"
printf '::add-mask::%s\n' "$runtime_url"

APP_ENV=staging \
DEPLOY_REVISION="$DEPLOY_REVISION" \
DATABASE_URL="$runtime_url" \
DATABASE_SSL_ROOT_CERT_FILE="$database_ssl_root_cert_file" \
  pnpm --silent run ops:bootstrap:content

printf '{"event":"staging.content.jit.complete","revision":"%s"}\n' "$DEPLOY_REVISION"
