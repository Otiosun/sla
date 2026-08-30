#!/usr/bin/env bash
set -Eeuo pipefail

workflow=".github/workflows/staging-database-release.yml"
release_script="scripts/operations/staging-database-release.sh"

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

# The external staging mutation is deliberate, serialized, and pinned to canonical main.
require_literal "$workflow" "workflow_dispatch:"
reject_literal "$workflow" "push:"
require_literal "$workflow" "environment: staging"
require_literal "$workflow" "cancel-in-progress: false"
require_literal "$workflow" "refs/heads/main"
require_literal "$workflow" 'DEPLOY_REVISION: ${{ github.sha }}'
require_literal "$workflow" "run_application_smoke"

# No credentials or provider hostnames are committed. GitHub environment secrets supply them.
require_literal "$workflow" 'STAGING_DATABASE_OWNER_URL: ${{ secrets.STAGING_DATABASE_OWNER_URL }}'
require_literal "$workflow" 'MIGRATOR_DATABASE_URL: ${{ secrets.STAGING_MIGRATOR_DATABASE_URL }}'
require_literal "$workflow" 'DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}'
require_literal "$workflow" 'MIGRATOR_PASSWORD: ${{ secrets.STAGING_MIGRATOR_PASSWORD }}'
require_literal "$workflow" 'RUNTIME_PASSWORD: ${{ secrets.STAGING_RUNTIME_PASSWORD }}'
require_literal "$workflow" 'WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}'
reject_literal "$workflow" "supabase.co"
reject_literal "$workflow" "postgresql://"

# The release operation must reuse the canonical fail-closed deployment order.
require_literal "$release_script" "APP_ENV_must_be_staging"
require_literal "$release_script" "db/bootstrap/roles.sql"
require_literal "$release_script" "scripts/operations/release-migrate.sh"
require_literal "$release_script" "db/bootstrap/runtime_grants.sql"
require_literal "$release_script" "pnpm db:verify"
require_literal "$release_script" "pokemon_migrator"
require_literal "$release_script" "pokemon_runtime"
require_literal "$release_script" "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"

# Runtime smoke is read-only and may only be requested after the database release itself passes.
require_literal "$workflow" "pnpm --silent run ops:smoke:application"
require_literal "$workflow" "if: inputs.run_application_smoke"

printf 'Phase 17 staging database release contract proof passed.\n'
