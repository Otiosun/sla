#!/usr/bin/env bash
set -euo pipefail

readonly POSTGRES_DUMP_IMAGE="postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2"
readonly DEFAULT_RETENTION_DAYS="30"
readonly DEFAULT_PREFIX="pokemon-rpg/postgres"

fail() {
  printf 'backup error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "required environment variable is empty: $name"
}

require_command docker
require_command aws
require_command sha256sum
require_command date

require_env DATABASE_URL
require_env BACKUP_S3_BUCKET
require_env AWS_ACCESS_KEY_ID
require_env AWS_SECRET_ACCESS_KEY
require_env AWS_REGION

retention_days="${BACKUP_RETENTION_DAYS:-$DEFAULT_RETENTION_DAYS}"
[[ "$retention_days" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_RETENTION_DAYS must be a positive integer"

prefix="${BACKUP_S3_PREFIX:-$DEFAULT_PREFIX}"
[[ "$prefix" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "BACKUP_S3_PREFIX contains unsupported characters"
prefix="${prefix#/}"
prefix="${prefix%/}"
[[ -n "$prefix" ]] || fail "BACKUP_S3_PREFIX must not resolve to an empty prefix"

[[ "$BACKUP_S3_BUCKET" =~ ^[A-Za-z0-9.-]+$ ]] || fail "BACKUP_S3_BUCKET contains unsupported characters"

started_at="${BACKUP_NOW_UTC:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
if ! date -u -d "$started_at" +%s >/dev/null 2>&1; then
  fail "BACKUP_NOW_UTC must be parseable as an absolute UTC timestamp"
fi

stamp="$(date -u -d "$started_at" +%Y%m%dT%H%M%SZ)"
source_sha="${GITHUB_SHA:-unknown}"
[[ "$source_sha" =~ ^([0-9a-f]{40}|unknown)$ ]] || fail "GITHUB_SHA must be a 40-character lowercase hex SHA when provided"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

dump_name="postgres-${stamp}-${source_sha}.dump"
dump_path="$workdir/$dump_name"
checksum_path="$dump_path.sha256"
manifest_path="$dump_path.json"

# Keep the PostgreSQL client pinned to the same major/server image used by permanent CI proofs.
docker run --rm \
  --env DATABASE_URL \
  --volume "$workdir:/backup" \
  "$POSTGRES_DUMP_IMAGE" \
  sh -ceu 'pg_dump --dbname "$DATABASE_URL" --format custom --no-owner --no-acl --file "/backup/'"$dump_name"'"'

[[ -s "$dump_path" ]] || fail "pg_dump produced an empty backup"
(
  cd "$workdir"
  sha256sum "$dump_name" > "$(basename "$checksum_path")"
)

cat >"$manifest_path" <<EOF
{"createdAt":"$started_at","gitSha":"$source_sha","postgresImage":"$POSTGRES_DUMP_IMAGE","retentionDays":$retention_days,"dump":"$dump_name"}
EOF

base_uri="s3://$BACKUP_S3_BUCKET/$prefix"
for path in "$dump_path" "$checksum_path" "$manifest_path"; do
  aws s3 cp "$path" "$base_uri/$(basename "$path")" \
    --only-show-errors \
    --sse AES256
 done

cutoff="$(date -u -d "$retention_days days ago" +%Y-%m-%dT%H:%M:%SZ)"
expired_keys="$(
  aws s3api list-objects-v2 \
    --bucket "$BACKUP_S3_BUCKET" \
    --prefix "$prefix/postgres-" \
    --query "Contents[?LastModified<=\`$cutoff\`].Key" \
    --output text
)"

if [[ -n "$expired_keys" && "$expired_keys" != "None" ]]; then
  while IFS=$'\t' read -r -a keys; do
    for key in "${keys[@]}"; do
      [[ -n "$key" ]] || continue
      [[ "$key" == "$prefix/postgres-"* ]] || fail "refusing to delete object outside controlled backup prefix"
      aws s3 rm "s3://$BACKUP_S3_BUCKET/$key" --only-show-errors
    done
  done <<<"$expired_keys"
fi

printf 'backup complete: %s (retention=%s days)\n' "$dump_name" "$retention_days"
