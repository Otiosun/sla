#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fake_bin="$tmpdir/bin"
mkdir -p "$fake_bin"
aws_log="$tmpdir/aws.log"

cat >"$fake_bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_AWS_LOG:?}"
printf '%q ' "$@" >>"$FAKE_AWS_LOG"
printf '\n' >>"$FAKE_AWS_LOG"

if [[ "${1:-}" == "s3" && "${2:-}" == "cp" ]]; then
  source_path="${3:-}"
  [[ -s "$source_path" ]] || {
    printf 'fake aws: upload source is missing or empty: %s\n' "$source_path" >&2
    exit 1
  }
  exit 0
fi

if [[ "${1:-}" == "s3api" && "${2:-}" == "list-objects-v2" ]]; then
  printf 'pokemon-rpg/postgres/postgres-20000101T000000Z-unknown.dump\n'
  exit 0
fi

if [[ "${1:-}" == "s3" && "${2:-}" == "rm" ]]; then
  exit 0
fi

printf 'fake aws: unsupported invocation\n' >&2
exit 1
EOF
chmod +x "$fake_bin/aws"

export PATH="$fake_bin:$PATH"
export FAKE_AWS_LOG="$aws_log"
export DATABASE_URL="postgresql://pokemon:test-only-password@localhost:5432/pokemon_rpg_test"
export BACKUP_DOCKER_NETWORK="container:pokemon-postgres"
export BACKUP_S3_BUCKET="phase16-proof-bucket"
export BACKUP_S3_PREFIX="pokemon-rpg/postgres"
export BACKUP_RETENTION_DAYS="30"
export BACKUP_NOW_UTC="2026-08-29T12:00:00Z"
export AWS_ACCESS_KEY_ID="proof-only"
export AWS_SECRET_ACCESS_KEY="proof-only"
export AWS_REGION="us-east-1"
export GITHUB_SHA="0123456789abcdef0123456789abcdef01234567"

bash -n "$repo_root/scripts/operations/postgres-backup.sh"
bash "$repo_root/scripts/operations/postgres-backup.sh"

upload_count="$(grep -c '^s3 cp ' "$aws_log")"
[[ "$upload_count" == "3" ]] || {
  printf 'expected 3 backup uploads, got %s\n' "$upload_count" >&2
  cat "$aws_log" >&2
  exit 1
}

grep -q '^s3api list-objects-v2 ' "$aws_log"
grep -q '^s3 rm s3://phase16-proof-bucket/pokemon-rpg/postgres/postgres-20000101T000000Z-unknown.dump ' "$aws_log"
grep -q -- '--sse AES256' "$aws_log"

printf 'Phase 16 automated backup proof passed.\n'
