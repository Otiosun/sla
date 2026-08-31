#!/usr/bin/env bash
set -Eeuo pipefail

workflow=".github/workflows/staging-content-bootstrap.yml"
jit_script="scripts/operations/staging-content-bootstrap-supabase-jit.sh"
bootstrap_script="scripts/operations/staging-content-bootstrap.ts"
ca_file="certs/supabase/prod-ca-2021.crt"

fail() {
  printf 'staging content bootstrap contract failed: %s\n' "$1" >&2
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
[[ -f "$jit_script" ]] || fail "missing ${jit_script}"
[[ -f "$bootstrap_script" ]] || fail "missing ${bootstrap_script}"
[[ -f "$ca_file" ]] || fail "missing ${ca_file}"
bash -n "$jit_script"

# The external mutation is manual, serialized, staging-scoped, and fail-closed on canonical main.
require_literal "$workflow" "name: Staging Content Bootstrap"
require_literal "$workflow" "workflow_dispatch:"
reject_literal "$workflow" "push:"
reject_literal "$workflow" "schedule:"
require_literal "$workflow" "permissions:"
require_literal "$workflow" "contents: read"
require_literal "$workflow" "environment: staging"
require_literal "$workflow" "cancel-in-progress: false"
require_literal "$workflow" "refs/heads/main"
require_literal "$workflow" 'DEPLOY_REVISION: ${{ github.sha }}'
require_literal "$workflow" 'STAGING_SUPABASE_PROJECT_REF: ${{ vars.STAGING_SUPABASE_PROJECT_REF }}'
require_literal "$workflow" 'STAGING_SUPABASE_POOLER_HOST: ${{ vars.STAGING_SUPABASE_POOLER_HOST }}'
require_literal "$workflow" 'STAGING_SUPABASE_JIT_TOKEN: ${{ secrets.STAGING_SUPABASE_JIT_TOKEN }}'
require_literal "$workflow" "bash scripts/operations/staging-content-bootstrap-supabase-jit.sh"
reject_literal "$workflow" "STAGING_DATABASE_OWNER_URL"
reject_literal "$workflow" "MIGRATOR_DATABASE_URL"
reject_literal "$workflow" "WHATSAPP_SESSION_KEY"
reject_literal "$workflow" "flyctl"
reject_literal "$workflow" "bootstrap-initial-admin"
reject_literal "$workflow" "bootstrap-whatsapp-session"
reject_literal "$workflow" "postgresql://"

# Source provenance must be identical to the final Phase 15 proof.
require_literal "$workflow" "PokeAPI/pokeapi"
require_literal "$workflow" "7af36d9f3424366ffc46e90d94c8bc120df39cd0"
require_literal "$workflow" "pret/pokefirered"
require_literal "$workflow" "c75f352304d529f6ba92d4f74b9cf8b5c3810788"
require_literal "$workflow" "pret/pokecrystal"
require_literal "$workflow" "7a7881d0d62e0ddbd82dcf10e7116807487ac651"
require_literal "$workflow" "pret/pokeemerald"
require_literal "$workflow" "c65e93f20a5275ab03b07d6f6411096a82a60ffd"
require_literal "$workflow" "POKEAPI_DATA_DIR"
require_literal "$workflow" "POKEFIRERED_DIR"
require_literal "$workflow" "POKECRYSTAL_DIR"
require_literal "$workflow" "POKEEMERALD_DIR"

# JIT bootstrap must derive only the least-privileged runtime URL and mask credentials.
require_literal "$jit_script" "APP_ENV_must_be_staging"
require_literal "$jit_script" "DEPLOY_REVISION_must_be_full_commit_sha"
require_literal "$jit_script" "STAGING_SUPABASE_JIT_TOKEN"
require_literal "$jit_script" "STAGING_SUPABASE_PROJECT_REF"
require_literal "$jit_script" "STAGING_SUPABASE_POOLER_HOST"
require_literal "$jit_script" "pokemon_runtime"
require_literal "$jit_script" "sslmode=verify-full"
require_literal "$jit_script" "jit=true"
require_literal "$jit_script" "NODE_EXTRA_CA_CERTS"
require_literal "$jit_script" "::add-mask::"
require_literal "$jit_script" "ops:bootstrap:content"
reject_literal "$jit_script" "pokemon_migrator"
reject_literal "$jit_script" "postgres."
reject_literal "$jit_script" "sslmode=require"
reject_literal "$jit_script" "set -x"

# Bootstrap orchestration must keep unrelated ceremonies out and activate only after validation/publication.
require_literal "$bootstrap_script" "APP_ENV"
require_literal "$bootstrap_script" "staging"
require_literal "$bootstrap_script" "verifyAppliedMigrations"
require_literal "$bootstrap_script" "db:seed:phase4"
require_literal "$bootstrap_script" "importGen123"
require_literal "$bootstrap_script" "applyGen123World"
require_literal "$bootstrap_script" "validateGen123Final"
require_literal "$bootstrap_script" "publishGen123"
require_literal "$bootstrap_script" "activateRelease"
require_literal "$bootstrap_script" "386"
require_literal "$bootstrap_script" "15001"
require_literal "$bootstrap_script" "unexpected"
reject_literal "$bootstrap_script" "bootstrap-initial-admin"
reject_literal "$bootstrap_script" "bootstrap-whatsapp-session"
reject_literal "$bootstrap_script" "flyctl"

# Execute the JIT wrapper offline and intercept pnpm at the network boundary.
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
cat > "$probe_dir/pnpm" <<'PROBE'
#!/bin/sh
{
  printf 'database=%s\n' "${DATABASE_URL:-}"
  printf 'app_env=%s\n' "${APP_ENV:-}"
  printf 'revision=%s\n' "${DEPLOY_REVISION:-}"
  printf 'node_ca=%s\n' "${NODE_EXTRA_CA_CERTS:-}"
  printf 'argv=%s\n' "$*"
} > "$JIT_CAPTURE_FILE"
exit 0
PROBE
chmod +x "$probe_dir/pnpm"

JIT_CAPTURE_FILE="$probe_dir/capture" \
PATH="$probe_dir:$PATH" \
APP_ENV=staging \
DEPLOY_REVISION=0000000000000000000000000000000000000001 \
STAGING_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst \
STAGING_SUPABASE_POOLER_HOST=aws-0-sa-east-1.pooler.supabase.com \
STAGING_SUPABASE_JIT_TOKEN=sbp_test_token_123 \
  /usr/bin/bash "$jit_script" > "$probe_dir/wrapper-output"

require_literal "$probe_dir/capture" "database=postgresql://pokemon_runtime.abcdefghijklmnopqrst:sbp_test_token_123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20jit%3Dtrue"
require_literal "$probe_dir/capture" "app_env=staging"
require_literal "$probe_dir/capture" "revision=0000000000000000000000000000000000000001"
require_literal "$probe_dir/capture" "node_ca="
require_literal "$probe_dir/capture" "certs/supabase/prod-ca-2021.crt"
require_literal "$probe_dir/capture" "argv=--silent run ops:bootstrap:content"

printf 'Phase 17 staging content bootstrap contract proof passed.\n'
