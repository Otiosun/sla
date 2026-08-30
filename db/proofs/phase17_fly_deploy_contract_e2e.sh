#!/usr/bin/env bash
set -Eeuo pipefail

config="fly.staging.toml"
workflow=".github/workflows/staging-runtime-deploy.yml"
environments_doc="docs/operations/environments-release.md"
recovery_doc="docs/operations/release-recovery-runbook.md"

fail() {
  printf 'Fly staging deploy contract failed: %s\n' "$1" >&2
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

[[ -f "$config" ]] || fail "missing ${config}"
[[ -f "$workflow" ]] || fail "missing ${workflow}"
[[ -f "$environments_doc" ]] || fail "missing ${environments_doc}"
[[ -f "$recovery_doc" ]] || fail "missing ${recovery_doc}"

# Fly target: one small always-on worker in Sao Paulo. No proxy service or local volume.
require_literal "$config" 'primary_region = "gru"'
require_literal "$config" 'kill_signal = "SIGTERM"'
require_literal "$config" 'APP_ENV = "staging"'
require_literal "$config" 'policy = "always"'
require_literal "$config" 'size = "shared-cpu-1x"'
require_literal "$config" 'memory = "512mb"'
reject_literal "$config" '[[services]]'
reject_literal "$config" '[http_service]'
reject_literal "$config" '[[mounts]]'
reject_literal "$config" 'MIGRATOR_DATABASE_URL'
reject_literal "$config" 'auto_stop_machines = "stop"'
reject_literal "$config" 'auto_stop_machines = "suspend"'

# Deployment is a manual, serialized, staging-environment mutation from canonical main only.
require_literal "$workflow" 'workflow_dispatch:'
require_literal "$workflow" 'environment: staging'
require_literal "$workflow" 'refs/heads/main'
require_literal "$workflow" 'cancel-in-progress: false'
require_literal "$workflow" 'contents: read'
require_literal "$workflow" 'packages: read'
reject_literal "$workflow" 'push:'
reject_literal "$workflow" 'pull_request:'

# The workflow consumes the already-published immutable GHCR artifact; Fly never rebuilds source.
require_literal "$workflow" 'ghcr.io/${GITHUB_REPOSITORY,,}:sha-${GITHUB_SHA}'
require_literal "$workflow" 'docker pull "$RUNTIME_IMAGE_GHCR"'
require_literal "$workflow" 'org.opencontainers.image.revision'
require_literal "$workflow" 'registry.fly.io/${FLY_APP}:sha-${GITHUB_SHA}'
require_literal "$workflow" 'flyctl auth docker'
require_literal "$workflow" 'docker push "$RUNTIME_IMAGE_FLY"'
require_literal "$workflow" '--image "$RUNTIME_IMAGE_FLY"'
require_literal "$workflow" '--config fly.staging.toml'
require_literal "$workflow" '--ha=false'
require_literal "$workflow" '--strategy immediate'
require_literal "$workflow" '--env "DEPLOY_REVISION=${GITHUB_SHA}"'
reject_literal "$workflow" ':main'
reject_literal "$workflow" '--remote-only'
reject_literal "$workflow" 'docker build'

# One-session safety: explicitly normalize the process group to one Machine after deploy.
require_literal "$workflow" 'flyctl scale count 1'

# Fly credentials and app identity are environment-scoped; database runtime credentials are not migrator credentials.
require_literal "$workflow" 'FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}'
require_literal "$workflow" 'FLY_APP: ${{ vars.STAGING_FLY_APP }}'
require_literal "$workflow" 'DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}'
require_literal "$workflow" 'WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}'
reject_literal "$workflow" 'STAGING_MIGRATOR_DATABASE_URL'
reject_literal "$workflow" 'MIGRATOR_DATABASE_URL:'

# A deploy is not successful until the exact revision/session obtains fresh provider-live evidence.
require_literal "$workflow" 'DEPLOY_REVISION: ${{ github.sha }}'
require_literal "$workflow" 'pnpm --silent run ops:smoke:application'
require_literal "$workflow" 'providerLiveHealth'
require_literal "$workflow" 'finalPostDeploySmokeComplete'

# Operator docs must preserve immutable rollback and the single-worker/no-migrator-runtime invariants.
require_literal "$environments_doc" 'Fly.io'
require_literal "$environments_doc" 'one Machine'
require_literal "$environments_doc" 'runtime must not receive `MIGRATOR_DATABASE_URL`'
require_literal "$recovery_doc" 'registry.fly.io'
require_literal "$recovery_doc" '--strategy immediate'
require_literal "$recovery_doc" 'one Machine'

printf 'Phase 17 Fly staging deploy contract proof passed.\n'
