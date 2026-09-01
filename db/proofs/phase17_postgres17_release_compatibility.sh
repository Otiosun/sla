set -euo pipefail

container="pokemon-postgres17-release-proof"
database="pokemon_release_proof"
migrator_role="pokemon_migrator"
runtime_role="pokemon_runtime"
migrator_password="migrator-proof-password"
runtime_password="runtime-proof-password"
revision="phase17-postgres17-release-proof"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run --detach \
  --name "$container" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres-proof-password \
  --env POSTGRES_DB=postgres \
  postgres:17.6-alpine@sha256:a14d4436f36a1290d05cfc902df0f559d2e9f95d27e2a2703ce9a544b867cf92 >/dev/null

for attempt in {1..30}; do
  if docker exec \
    --env PGPASSWORD=postgres-proof-password \
    "$container" psql \
    --username postgres \
    --dbname postgres \
    --tuples-only \
    --command "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

docker exec \
  --env PGPASSWORD=postgres-proof-password \
  "$container" psql \
  --username postgres \
  --dbname postgres \
  --set ON_ERROR_STOP=1 \
  --command "CREATE ROLE ${migrator_role} LOGIN PASSWORD '${migrator_password}'" \
  --command "CREATE ROLE ${runtime_role} LOGIN PASSWORD '${runtime_password}'" \
  --command "CREATE DATABASE ${database} OWNER ${migrator_role}"

docker exec \
  --env PGPASSWORD=postgres-proof-password \
  "$container" psql \
  --username postgres \
  --dbname "$database" \
  --set ON_ERROR_STOP=1 \
  --command "REVOKE CREATE ON SCHEMA public FROM PUBLIC" \
  --command "GRANT USAGE ON SCHEMA public TO ${runtime_role}" \
  --command "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator_role} IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtime_role}"

host="127.0.0.1"
port="$(docker inspect --format='{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")"
migrator_url="postgresql://${migrator_role}:${migrator_password}@${host}:${port}/${database}?sslmode=disable"
runtime_url="postgresql://${runtime_role}:${runtime_password}@${host}:${port}/${database}?sslmode=disable"

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
if [[ "$migration_count" != "27" ]]; then
  echo "expected 27 applied migrations on PostgreSQL 17.6, got ${migration_count}" >&2
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
  --command "INSERT INTO whatsapp_sessions(session_key, auth_state_ciphertext, auth_state_nonce, auth_state_tag, key_version) VALUES ('${session_key}', decode('00','hex'), decode(repeat('00', 12),'hex'), decode(repeat('00', 16),'hex'), 1)"

APP_ENV=staging \
DATABASE_URL="$runtime_url" \
MIGRATOR_DATABASE_URL="$migrator_url" \
WHATSAPP_SESSION_KEY="$session_key" \
  node --import tsx db/proofs/phase17_application_smoke_e2e.ts --schema-only

printf '%s\n' '{"proof":"phase17-postgres17-release-compatibility","postgres":"17.6","migrations":27,"runtimeVerify":true,"bootstrap":true,"seed":true,"schemaSmoke":true}'
