#!/usr/bin/env bash
set -Eeuo pipefail

workflow=".github/workflows/railway-staging-runtime-deploy.yml"
fly_workflow=".github/workflows/staging-runtime-deploy.yml"
fly_config="fly.staging.toml"
environments_doc="docs/operations/environments-release.md"
recovery_doc="docs/operations/release-recovery-runbook.md"
railway_doc="docs/operations/railway-staging-runtime.md"

fail() {
  printf 'Railway staging deploy contract failed: %s\n' "$1" >&2
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
[[ -f "$fly_workflow" ]] || fail "Fly fallback workflow was removed"
[[ -f "$fly_config" ]] || fail "Fly fallback config was removed"
[[ -f "$environments_doc" ]] || fail "missing ${environments_doc}"
[[ -f "$recovery_doc" ]] || fail "missing ${recovery_doc}"
[[ -f "$railway_doc" ]] || fail "missing ${railway_doc}"

# Canonical staging deploy is manual, serialized, environment-scoped and main-only.
require_literal "$workflow" 'workflow_dispatch:'
require_literal "$workflow" 'environment: staging'
require_literal "$workflow" 'refs/heads/main'
require_literal "$workflow" 'cancel-in-progress: false'
require_literal "$workflow" 'contents: read'
require_literal "$workflow" 'packages: read'
reject_literal "$workflow" 'push:'
reject_literal "$workflow" 'pull_request:'

# Railway identity/authentication stays outside Git and the service target is explicit.
require_literal "$workflow" 'RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}'
require_literal "$workflow" 'RAILWAY_SERVICE: ${{ vars.STAGING_RAILWAY_SERVICE }}'
require_literal "$workflow" 'pokemon-rpg-whatsapp-staging'
require_literal "$workflow" 'npm install --global @railway/cli@5.45.10'

# The already-published immutable GHCR artifact is verified before Railway is mutated.
require_literal "$workflow" 'repository_lower="${GITHUB_REPOSITORY,,}"'
require_literal "$workflow" 'RUNTIME_IMAGE_GHCR=ghcr.io/${repository_lower}:sha-${GITHUB_SHA}'
require_literal "$workflow" 'docker pull "$RUNTIME_IMAGE_GHCR"'
require_literal "$workflow" 'org.opencontainers.image.revision'
reject_literal "$workflow" ':latest'
reject_literal "$workflow" ':main'
reject_literal "$workflow" ':staging'
reject_literal "$workflow" 'docker build'
reject_literal "$workflow" 'railway up'

# Runtime-only secret boundary is checked by names without committing or printing values.
require_literal "$workflow" 'railway variable list'
require_literal "$workflow" 'DATABASE_URL WHATSAPP_SESSION_KEY WHATSAPP_AUTH_KEY_BASE64 WHATSAPP_AUTH_KEY_VERSION'
require_literal "$workflow" 'MIGRATOR_DATABASE_URL'
reject_literal "$workflow" 'MIGRATOR_DATABASE_URL:'
reject_literal "$workflow" 'STAGING_MIGRATOR_DATABASE_URL'

# Provider safety: exactly one configured replica and no old/new Baileys overlap.
require_literal "$workflow" 'railway scale'
require_literal "$workflow" 'us-east=1'
require_literal "$workflow" 'us-west=0'
require_literal "$workflow" 'eu-west=0'
require_literal "$workflow" 'southeast-asia=0'
require_literal "$workflow" 'railway down'
require_literal "$workflow" '--yes'
require_literal "$workflow" 'REMOVED'
require_literal "$workflow" 'previous Railway deployment did not stop before replacement'

# Exact revision is staged without its own redeploy, then the exact Docker image becomes the source.
require_literal "$workflow" 'railway variable set DEPLOY_REVISION=${GITHUB_SHA}'
require_literal "$workflow" '--skip-deploys'
require_literal "$workflow" 'railway service source connect'
require_literal "$workflow" '--image "$RUNTIME_IMAGE_GHCR"'
require_literal "$workflow" 'railway deployment list'
require_literal "$workflow" 'SUCCESS'
require_literal "$workflow" 'FAILED|CRASHED|REMOVED'

# A deploy is not GREEN until the exact revision/session has fresh provider-live evidence.
require_literal "$workflow" 'DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}'
require_literal "$workflow" 'WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}'
require_literal "$workflow" 'DEPLOY_REVISION: ${{ github.sha }}'
require_literal "$workflow" 'pnpm --silent run ops:smoke:application'
require_literal "$workflow" 'providerLiveHealth'
require_literal "$workflow" 'finalPostDeploySmokeComplete'

# Operator docs make Railway canonical for this validation window and retain Fly as fallback.
require_literal "$environments_doc" 'Railway'
require_literal "$environments_doc" 'Fly.io fallback'
require_literal "$recovery_doc" 'Railway'
require_literal "$railway_doc" 'RAILWAY_TOKEN'
require_literal "$railway_doc" 'STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging'
require_literal "$railway_doc" 'Fly.io'
require_literal "$railway_doc" 'MIGRATOR_DATABASE_URL'
require_literal "$railway_doc" 'railway down'

printf 'Phase 17 Railway staging deploy contract proof passed.\n'
