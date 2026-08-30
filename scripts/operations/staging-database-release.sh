#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '{"event":"staging.database.release.rejected","reason":"%s"}\n' "$1" >&2
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
require_env STAGING_DATABASE_OWNER_URL
require_env MIGRATOR_DATABASE_URL
require_env DATABASE_URL

[[ "$APP_ENV" == "staging" ]] || fail "APP_ENV_must_be_staging"
[[ "$DEPLOY_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "DEPLOY_REVISION_must_be_full_commit_sha"
[[ "$MIGRATOR_DATABASE_URL" != "$DATABASE_URL" ]] || fail "runtime_and_migrator_urls_must_differ"

command -v docker >/dev/null 2>&1 || fail "docker_not_available"
command -v pnpm >/dev/null 2>&1 || fail "pnpm_not_available"

migrator_role="pokemon_migrator"
runtime_role="pokemon_runtime"
psql_image="postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
bootstrap_mode="${STAGING_ROLE_BOOTSTRAP_MODE:-password}"

psql_tls_args=()
if [[ -n "${DATABASE_SSL_ROOT_CERT_FILE:-}" ]]; then
  [[ -f "$DATABASE_SSL_ROOT_CERT_FILE" ]] || fail "database_ssl_root_cert_file_not_found"
  database_ssl_root_cert_file="$(cd "$(dirname "$DATABASE_SSL_ROOT_CERT_FILE")" && pwd)/$(basename "$DATABASE_SSL_ROOT_CERT_FILE")"
  export NODE_EXTRA_CA_CERTS="$database_ssl_root_cert_file"
  psql_tls_args=(
    --volume "${database_ssl_root_cert_file}:/run/pokemon-rpg/database-root-ca.crt:ro"
    --env "PGSSLROOTCERT=/run/pokemon-rpg/database-root-ca.crt"
  )
fi

printf '{"event":"staging.database.release.start","revision":"%s","roleBootstrapMode":"%s"}\n' \
  "$DEPLOY_REVISION" "$bootstrap_mode"

case "$bootstrap_mode" in
  password)
    require_env MIGRATOR_PASSWORD
    require_env RUNTIME_PASSWORD

    # Provider-owner ceremony: create/rotate only the two environment login roles and schema grants.
    docker run --rm -i \
      "${psql_tls_args[@]}" \
      --env STAGING_DATABASE_OWNER_URL \
      --env MIGRATOR_PASSWORD \
      --env RUNTIME_PASSWORD \
      "$psql_image" \
      sh -ceu '
        exec psql "$STAGING_DATABASE_OWNER_URL" \
          --set ON_ERROR_STOP=1 \
          --set "migrator_role=pokemon_migrator" \
          --set "migrator_password=${MIGRATOR_PASSWORD}" \
          --set "runtime_role=pokemon_runtime" \
          --set "runtime_password=${RUNTIME_PASSWORD}"
      ' < db/bootstrap/roles.sql
    ;;

  existing_roles)
    # Temporary-access/JIT providers authenticate without changing the role password. Refuse to
    # proceed unless the externally provisioned roles already match the canonical least-privilege
    # contract. This path never rotates or invents a persistent database password.
    docker run --rm \
      "${psql_tls_args[@]}" \
      --env STAGING_DATABASE_OWNER_URL \
      "$psql_image" \
      sh -ceu '
        exec psql "$STAGING_DATABASE_OWNER_URL" --set ON_ERROR_STOP=1 <<'"'"'SQL'"'"'
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = '"'"'pokemon_migrator'"'"'
      AND rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION '"'"'pokemon_migrator role attributes do not match the staging contract'"'"';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = '"'"'pokemon_runtime'"'"'
      AND rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION '"'"'pokemon_runtime role attributes do not match the staging contract'"'"';
  END IF;

  IF NOT has_schema_privilege('"'"'pokemon_migrator'"'"', '"'"'public'"'"', '"'"'USAGE'"'"')
     OR NOT has_schema_privilege('"'"'pokemon_migrator'"'"', '"'"'public'"'"', '"'"'CREATE'"'"') THEN
    RAISE EXCEPTION '"'"'pokemon_migrator schema privileges do not match the staging contract'"'"';
  END IF;

  IF NOT has_schema_privilege('"'"'pokemon_runtime'"'"', '"'"'public'"'"', '"'"'USAGE'"'"')
     OR has_schema_privilege('"'"'pokemon_runtime'"'"', '"'"'public'"'"', '"'"'CREATE'"'"') THEN
    RAISE EXCEPTION '"'"'pokemon_runtime schema privileges do not match the staging contract'"'"';
  END IF;
END
$verify$;
SQL
      '
    ;;

  *)
    fail "STAGING_ROLE_BOOTSTRAP_MODE_must_be_password_or_existing_roles"
    ;;
esac

# Refuse a secret/URL mismatch before any numbered migration is attempted.
migrator_user="$(docker run --rm \
  "${psql_tls_args[@]}" \
  --env MIGRATOR_DATABASE_URL \
  "$psql_image" \
  sh -ceu 'exec psql "$MIGRATOR_DATABASE_URL" --tuples-only --no-align --set ON_ERROR_STOP=1 --command "SELECT current_user;"')"
[[ "$migrator_user" == "$migrator_role" ]] || fail "migrator_url_does_not_authenticate_as_pokemon_migrator"

runtime_user="$(docker run --rm \
  "${psql_tls_args[@]}" \
  --env DATABASE_URL \
  "$psql_image" \
  sh -ceu 'exec psql "$DATABASE_URL" --tuples-only --no-align --set ON_ERROR_STOP=1 --command "SELECT current_user;"')"
[[ "$runtime_user" == "$runtime_role" ]] || fail "runtime_url_does_not_authenticate_as_pokemon_runtime"

# Canonical migration runner: advisory lock, per-file transaction and immutable SHA-256 history.
APP_ENV=staging \
DATABASE_URL="$DATABASE_URL" \
MIGRATOR_DATABASE_URL="$MIGRATOR_DATABASE_URL" \
DEPLOY_REVISION="$DEPLOY_REVISION" \
  bash scripts/operations/release-migrate.sh

# Reconcile runtime grants as the schema-owning migrator. This also verifies object ownership.
docker run --rm -i \
  "${psql_tls_args[@]}" \
  --env MIGRATOR_DATABASE_URL \
  "$psql_image" \
  sh -ceu '
    exec psql "$MIGRATOR_DATABASE_URL" \
      --set ON_ERROR_STOP=1 \
      --set "migrator_role=pokemon_migrator" \
      --set "runtime_role=pokemon_runtime"
  ' < db/bootstrap/runtime_grants.sql

# Final runtime-side schema/checksum verification. A release is not complete without this.
APP_ENV=staging \
DATABASE_URL="$DATABASE_URL" \
MIGRATOR_DATABASE_URL="$MIGRATOR_DATABASE_URL" \
  pnpm db:verify

printf '{"event":"staging.database.release.complete","revision":"%s","roleBootstrapMode":"%s"}\n' \
  "$DEPLOY_REVISION" "$bootstrap_mode"
