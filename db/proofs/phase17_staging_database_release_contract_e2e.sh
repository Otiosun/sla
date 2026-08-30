#!/usr/bin/env bash
set -Eeuo pipefail

workflow=".github/workflows/staging-database-release.yml"
release_script="scripts/operations/staging-database-release.sh"
jit_script="scripts/operations/staging-database-release-supabase-jit.sh"

fail() {
  printf 'staging database release contract failed: %s\n' "$1" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local literal="$2"
  grep -Fq -- "$literal" "$file" || fail "${file} missing required literal: ${literal}"
}

reject_literal() {
  local file="$1"
  local literal="$2"
  if grep -Fq -- "$literal" "$file"; then
    fail "${file} contains forbidden literal: ${literal}"
  fi
}

[[ -f "$workflow" ]] || fail "missing ${workflow}"
[[ -f "$release_script" ]] || fail "missing ${release_script}"
[[ -f "$jit_script" ]] || fail "missing ${jit_script}"
bash -n "$release_script"
bash -n "$jit_script"

# The external staging mutation is deliberate, serialized, and pinned to canonical main.
require_literal "$workflow" "workflow_dispatch:"
reject_literal "$workflow" "push:"
require_literal "$workflow" "environment: staging"
require_literal "$workflow" "cancel-in-progress: false"
require_literal "$workflow" "refs/heads/main"
require_literal "$workflow" 'DEPLOY_REVISION: ${{ github.sha }}'
require_literal "$workflow" "run_application_smoke"

# Password auth remains available for provider portability.
require_literal "$workflow" "database_auth_mode"
require_literal "$workflow" "supabase_jit"
require_literal "$workflow" "password"
require_literal "$workflow" 'STAGING_DATABASE_OWNER_URL: ${{ secrets.STAGING_DATABASE_OWNER_URL }}'
require_literal "$workflow" 'MIGRATOR_DATABASE_URL: ${{ secrets.STAGING_MIGRATOR_DATABASE_URL }}'
require_literal "$workflow" 'DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}'
require_literal "$workflow" 'MIGRATOR_PASSWORD: ${{ secrets.STAGING_MIGRATOR_PASSWORD }}'
require_literal "$workflow" 'RUNTIME_PASSWORD: ${{ secrets.STAGING_RUNTIME_PASSWORD }}'

# Supabase staging may instead use one expiring PAT through the IPv4 session pooler.
# Project ref and pooler host are non-secret environment variables; the PAT stays a secret.
require_literal "$workflow" 'STAGING_SUPABASE_PROJECT_REF: ${{ vars.STAGING_SUPABASE_PROJECT_REF }}'
require_literal "$workflow" 'STAGING_SUPABASE_POOLER_HOST: ${{ vars.STAGING_SUPABASE_POOLER_HOST }}'
require_literal "$workflow" 'STAGING_SUPABASE_JIT_TOKEN: ${{ secrets.STAGING_SUPABASE_JIT_TOKEN }}'
require_literal "$workflow" 'bash scripts/operations/staging-database-release-supabase-jit.sh'
require_literal "$workflow" "inputs.database_auth_mode == 'supabase_jit'"
require_literal "$workflow" "inputs.database_auth_mode == 'password'"
require_literal "$workflow" 'WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}'
reject_literal "$workflow" "postgresql://"

# The canonical release operation must preserve the same fail-closed deployment order.
require_literal "$release_script" "APP_ENV_must_be_staging"
require_literal "$release_script" "STAGING_ROLE_BOOTSTRAP_MODE"
require_literal "$release_script" "existing_roles"
require_literal "$release_script" "db/bootstrap/roles.sql"
require_literal "$release_script" "scripts/operations/release-migrate.sh"
require_literal "$release_script" "db/bootstrap/runtime_grants.sql"
require_literal "$release_script" "pnpm db:verify"
require_literal "$release_script" "pokemon_migrator"
require_literal "$release_script" "pokemon_runtime"
require_literal "$release_script" "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"

# The JIT wrapper must build three role-specific session-pooler URLs without role passwords.
require_literal "$jit_script" "STAGING_SUPABASE_JIT_TOKEN"
require_literal "$jit_script" "STAGING_SUPABASE_PROJECT_REF"
require_literal "$jit_script" "STAGING_SUPABASE_POOLER_HOST"
require_literal "$jit_script" "pokemon_migrator"
require_literal "$jit_script" "pokemon_runtime"
require_literal "$jit_script" "sslmode"
require_literal "$jit_script" "jit=true"
require_literal "$jit_script" "STAGING_ROLE_BOOTSTRAP_MODE=existing_roles"
require_literal "$jit_script" "::add-mask::"
reject_literal "$jit_script" "MIGRATOR_PASSWORD"
reject_literal "$jit_script" "RUNTIME_PASSWORD"
reject_literal "$jit_script" "set -x"

# Execute the real URL builder offline. Intercept the child `bash` exactly at the network release
# boundary, so this proves the values actually handed to the canonical release script without
# requiring provider credentials or network access.
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
cat > "$probe_dir/bash" <<'PROBE'
#!/bin/sh
{
  printf 'mode=%s\n' "${STAGING_ROLE_BOOTSTRAP_MODE:-}"
  printf 'owner=%s\n' "${STAGING_DATABASE_OWNER_URL:-}"
  printf 'migrator=%s\n' "${MIGRATOR_DATABASE_URL:-}"
  printf 'runtime=%s\n' "${DATABASE_URL:-}"
  printf 'migrator_password_present=%s\n' "${MIGRATOR_PASSWORD+x}"
  printf 'runtime_password_present=%s\n' "${RUNTIME_PASSWORD+x}"
} > "$JIT_CAPTURE_FILE"
exit 0
PROBE
chmod +x "$probe_dir/bash"

JIT_CAPTURE_FILE="$probe_dir/capture" \
PATH="$probe_dir:$PATH" \
APP_ENV=staging \
DEPLOY_REVISION=0000000000000000000000000000000000000001 \
STAGING_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst \
STAGING_SUPABASE_POOLER_HOST=aws-0-sa-east-1.pooler.supabase.com \
STAGING_SUPABASE_JIT_TOKEN=sbp_test_token_123 \
RUN_APPLICATION_SMOKE=false \
  /usr/bin/bash "$jit_script" > "$probe_dir/wrapper-output"

require_literal "$probe_dir/capture" "mode=existing_roles"
require_literal "$probe_dir/capture" "owner=postgresql://postgres.abcdefghijklmnopqrst:sbp_test_token_123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require&options=-c%20jit%3Dtrue"
require_literal "$probe_dir/capture" "migrator=postgresql://pokemon_migrator.abcdefghijklmnopqrst:sbp_test_token_123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require&options=-c%20jit%3Dtrue"
require_literal "$probe_dir/capture" "runtime=postgresql://pokemon_runtime.abcdefghijklmnopqrst:sbp_test_token_123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require&options=-c%20jit%3Dtrue"
require_literal "$probe_dir/capture" "migrator_password_present="
require_literal "$probe_dir/capture" "runtime_password_present="
reject_literal "$probe_dir/capture" "+jit%3Dtrue"

# Runtime smoke remains read-only and is only requested after release succeeds.
require_literal "$workflow" "pnpm --silent run ops:smoke:application"
require_literal "$workflow" "if: inputs.run_application_smoke && inputs.database_auth_mode == 'password'"
require_literal "$jit_script" "ops:smoke:application"

printf 'Phase 17 staging database release contract proof passed.\n'
