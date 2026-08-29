#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '{"event":"release.migration.rejected","reason":"%s"}\n' "$1" >&2
  exit 64
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "missing_${name}"
  fi
}

require_env APP_ENV
require_env DATABASE_URL
require_env MIGRATOR_DATABASE_URL
require_env DEPLOY_REVISION

case "$APP_ENV" in
  staging|production) ;;
  *) fail "APP_ENV_must_be_staging_or_production" ;;
esac

if [[ ! "$DEPLOY_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  fail "DEPLOY_REVISION_must_be_full_commit_sha"
fi

command -v pnpm >/dev/null 2>&1 || fail "pnpm_not_available"

export MIGRATION_APPLIED_BY="${MIGRATION_APPLIED_BY:-release:${APP_ENV}:${DEPLOY_REVISION}}"

printf '{"event":"release.migration.start","environment":"%s","revision":"%s"}\n' \
  "$APP_ENV" "$DEPLOY_REVISION"

pnpm db:migrate

printf '{"event":"release.migration.complete","environment":"%s","revision":"%s"}\n' \
  "$APP_ENV" "$DEPLOY_REVISION"
