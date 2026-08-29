#!/usr/bin/env bash
set -euo pipefail

container_name="pokemon-postgres"
source_db="pokemon_rpg_phase16_rollback_source"
restore_db="pokemon_rpg_phase16_rollback_restore"
probe_id="00000000-0000-4000-8000-000000001626"
dump_path="/tmp/${source_db}.dump"
source_url="postgresql://pokemon:test-only-password@localhost:5432/${source_db}"

# Build a current known-good source database using the production migrator path.
docker exec "$container_name" createdb --username pokemon "$source_db"
DATABASE_URL="$source_url" \
MIGRATOR_DATABASE_URL="$source_url" \
MIGRATION_APPLIED_BY="phase16-logical-rollback-source" \
  pnpm db:migrate

# Establish and fingerprint the known-good recovery point.
docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO players(id, status) VALUES ('${probe_id}', 'ACTIVE');"

known_good_state="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --tuples-only \
  --no-align \
  --command "SELECT status || ':' || revision::text FROM players WHERE id = '${probe_id}';")"
test "$known_good_state" = "ACTIVE:0"

known_good_migration_count="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM schema_migrations;")"
test "$known_good_migration_count" -ge 1

known_good_fingerprint="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --tuples-only \
  --no-align \
  --command "SELECT md5(COALESCE(string_agg(version::text || ':' || name || ':' || checksum, '|' ORDER BY version), '')) FROM schema_migrations;")"
test -n "$known_good_fingerprint"

# The backup is the recovery point; completion alone is not sufficient evidence.
docker exec "$container_name" pg_dump \
  --username pokemon \
  --dbname "$source_db" \
  --format custom \
  --file "$dump_path"

# Simulate a bad post-backup state. The recovery proof must restore the older
# known-good business state, not merely copy an unchanged source database.
docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --set ON_ERROR_STOP=1 \
  --command "UPDATE players SET status = 'SUSPENDED', revision = revision + 1 WHERE id = '${probe_id}';"

mutated_source_state="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --tuples-only \
  --no-align \
  --command "SELECT status || ':' || revision::text FROM players WHERE id = '${probe_id}';")"
test "$mutated_source_state" = "SUSPENDED:1"

# Logical rollback is restore-to-replacement, never an in-place destructive
# down-migration of the damaged source database.
docker exec "$container_name" createdb --username pokemon "$restore_db"
docker exec "$container_name" pg_restore \
  --username pokemon \
  --dbname "$restore_db" \
  --exit-on-error \
  "$dump_path"

restored_state="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$restore_db" \
  --tuples-only \
  --no-align \
  --command "SELECT status || ':' || revision::text FROM players WHERE id = '${probe_id}';")"
restored_migration_count="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$restore_db" \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM schema_migrations;")"
restored_fingerprint="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$restore_db" \
  --tuples-only \
  --no-align \
  --command "SELECT md5(COALESCE(string_agg(version::text || ':' || name || ':' || checksum, '|' ORDER BY version), '')) FROM schema_migrations;")"

# The replacement recovers the known-good point while the source remains bad,
# proving state rollback via restore rather than schema rewind.
test "$restored_state" = "$known_good_state"
test "$restored_state" != "$mutated_source_state"
test "$restored_migration_count" = "$known_good_migration_count"
test "$restored_fingerprint" = "$known_good_fingerprint"

source_state_after_restore="$(docker exec "$container_name" psql \
  --username pokemon \
  --dbname "$source_db" \
  --tuples-only \
  --no-align \
  --command "SELECT status || ':' || revision::text FROM players WHERE id = '${probe_id}';")"
test "$source_state_after_restore" = "$mutated_source_state"

DATABASE_URL="postgresql://pokemon:test-only-password@localhost:5432/${restore_db}" \
MIGRATOR_DATABASE_URL="postgresql://pokemon:test-only-password@localhost:5432/${restore_db}" \
  pnpm db:verify

printf '%s\n' \
  "phase16 logical rollback restore proof: PASS" \
  "known_good_state=${known_good_state}" \
  "mutated_source_state=${mutated_source_state}" \
  "restored_state=${restored_state}" \
  "migration_count=${restored_migration_count}"
