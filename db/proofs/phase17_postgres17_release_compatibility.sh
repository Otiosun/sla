#!/usr/bin/env bash
set -Eeuo pipefail

container="pokemon-postgres17-release-proof"
database="pokemon_rpg_pg17_compat"
admin_user="pokemon"
admin_password="test-only-password"
migrator_role="pokemon_pg17_migrator"
runtime_role="pokemon_pg17_runtime"
migrator_password="pg17-migrator-password"
runtime_password="pg17-runtime-password"
revision="${PROOF_REVISION:-}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "PROOF_REVISION must be a full lowercase 40-character commit SHA" >&2
  exit 1
fi

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach \
  --name "$container" \
  --env "POSTGRES_USER=${admin_user}" \
  --env "POSTGRES_PASSWORD=${admin_password}" \
  --env POSTGRES_DB=postgres \
  --publish 5432:5432 \
  postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94 >/dev/null

for attempt in {1..30}; do
  if docker exec \
    --env "PGPASSWORD=${admin_password}" \
    "$container" psql \
    --host 127.0.0.1 \
    --username "$admin_user" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --command "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

server_version="$(docker exec \
  --env "PGPASSWORD=${admin_password}" \
  "$container" psql \
  --host 127.0.0.1 \
  --username "$admin_user" \
  --dbname postgres \
  --tuples-only \
  --no-align \
  --command "SHOW server_version;")"
if [[ "$server_version" != 17.6* ]]; then
  echo "expected PostgreSQL 17.6 compatibility target, got ${server_version}" >&2
  exit 1
fi

docker exec \
  --env "PGPASSWORD=${admin_password}" \
  "$container" createdb \
  --host 127.0.0.1 \
  --username "$admin_user" \
  "$database"

docker exec -i \
  --env "PGPASSWORD=${admin_password}" \
  "$container" psql \
  --host 127.0.0.1 \
  --username "$admin_user" \
  --dbname "$database" \
  --set ON_ERROR_STOP=1 \
  --set "migrator_role=${migrator_role}" \
  --set "migrator_password=${migrator_password}" \
  --set "runtime_role=${runtime_role}" \
  --set "runtime_password=${runtime_password}" \
  < db/bootstrap/roles.sql

migrator_url="postgresql://${migrator_role}:${migrator_password}@localhost:5432/${database}"
runtime_url="postgresql://${runtime_role}:${runtime_password}@localhost:5432/${database}"

APP_ENV=staging \
DATABASE_URL="$runtime_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
DEPLOY_REVISION="$revision" \
  bash scripts/operations/release-migrate.sh

docker exec -i \
  --env "PGPASSWORD=${migrator_password}" \
  "$container" psql \
  --host 127.0.0.1 \
  --username "$migrator_role" \
  --dbname "$database" \
  --set ON_ERROR_STOP=1 \
  --set "migrator_role=${migrator_role}" \
  --set "runtime_role=${runtime_role}" \
  < db/bootstrap/runtime_grants.sql

APP_ENV=staging \
DATABASE_URL="$runtime_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
  pnpm db:verify

migration_count="$(docker exec \
  --env "PGPASSWORD=${runtime_password}" \
  "$container" psql \
  --host 127.0.0.1 \
  --username "$runtime_role" \
  --dbname "$database" \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM schema_migrations;")"
if [[ "$migration_count" != "25" ]]; then
  echo "expected 25 applied migrations on PostgreSQL 17.6, got ${migration_count}" >&2
  exit 1
fi

confirmation="bootstrap-initial-admin:staging:${revision}"
APP_ENV=staging \
DATABASE_URL="$runtime_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
DEPLOY_REVISION="$revision" \
ADMIN_BOOTSTRAP_IDENTITY_REF="proof:pg17-release-owner" \
ADMIN_BOOTSTRAP_CONFIRMATION="$confirmation" \
  node --import tsx db/proofs/phase17_initial_admin_bootstrap_e2e.ts

APP_ENV=staging \
DATABASE_URL="$runtime_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
  pnpm db:seed:phase4

session_key="pg17-release-smoke-proof"
docker exec \
  --env "PGPASSWORD=${runtime_password}" \
  "$container" psql \
  --host 127.0.0.1 \
  --username "$runtime_role" \
  --dbname "$database" \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO whatsapp_auth_sessions(session_key, credentials_ciphertext, credentials_iv, credentials_auth_tag, encryption_key_version) VALUES ('${session_key}', decode('00','hex'), decode(repeat('00',12),'hex'), decode(repeat('00',16),'hex'), 1) ON CONFLICT (session_key) DO NOTHING;"

smoke_json="$(APP_ENV=staging \
  DATABASE_URL="$runtime_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  DEPLOY_REVISION="$revision" \
  WHATSAPP_SESSION_KEY="$session_key" \
    pnpm --silent run ops:smoke:application)"

node -e '
  const report = JSON.parse(process.argv[1]);
  if (!report.passed) throw new Error(`PostgreSQL 17 application smoke failed: ${report.failures.join(",")}`);
  if (report.providerLiveHealth !== "NOT_PROBED") throw new Error("compatibility proof must not claim provider health");
  if (report.finalPostDeploySmokeComplete !== false) throw new Error("compatibility proof must not claim final 17.5 completion");
' "$smoke_json"

printf 'PostgreSQL %s release compatibility proof passed for revision %s\n' "$server_version" "$revision"
