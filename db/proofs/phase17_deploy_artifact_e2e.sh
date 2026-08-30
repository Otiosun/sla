#!/usr/bin/env bash
set -euo pipefail

image="pokemon-rpg-runtime:proof"
revision="${PROOF_REVISION:-0000000000000000000000000000000000000000}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "PROOF_REVISION must be a full lowercase 40-character commit SHA" >&2
  exit 1
fi

docker build \
  --build-arg "VCS_REF=${revision}" \
  --tag "$image" \
  .

image_user="$(docker inspect --format '{{.Config.User}}' "$image")"
if [[ -z "$image_user" || "$image_user" == "root" || "$image_user" == "0" ]]; then
  echo "runtime image must declare a non-root user; got '${image_user}'" >&2
  exit 1
fi

image_cmd="$(docker inspect --format '{{json .Config.Cmd}}' "$image")"
if [[ "$image_cmd" != '["node","dist/src/main.js"]' ]]; then
  echo "runtime image must use exec-form Node CMD without migration side effects; got ${image_cmd}" >&2
  exit 1
fi

image_revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
if [[ "$image_revision" != "$revision" ]]; then
  echo "runtime image revision label mismatch: expected ${revision}, got ${image_revision}" >&2
  exit 1
fi

if ! docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | grep -qx 'NODE_ENV=production'; then
  echo "runtime image must set NODE_ENV=production" >&2
  exit 1
fi

docker run --rm --entrypoint sh "$image" -ceu '
  test -f dist/src/main.js
  test -f dist/src/adapters/whatsapp/baileys-runtime.js
  test -f dist/db/migrations/0001_core_schema.sql
  test -f dist/db/migrations/0025_mutation_abuse_admission.sql

  test ! -e src
  test ! -e tests
  test ! -e scripts
  test ! -e .git
  test ! -e .env
  test ! -e .env.production
'

docker run --rm --entrypoint node "$image" -e '
  for (const dependency of ["pg", "zod", "@whiskeysockets/baileys"]) {
    require.resolve(dependency);
  }
'

docker run --rm --entrypoint node "$image" -e '
  for (const dependency of ["tsx", "typescript", "vitest", "@biomejs/biome"]) {
    try {
      require.resolve(dependency);
      throw new Error(`devDependency leaked into runtime image: ${dependency}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("devDependency leaked")) {
        throw error;
      }
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
  }
'

set +e
startup_output="$(docker run --rm "$image" 2>&1)"
startup_status=$?
set -e

if [[ $startup_status -eq 0 ]]; then
  echo "runtime image unexpectedly started without DATABASE_URL" >&2
  exit 1
fi

if ! grep -q 'Invalid application configuration' <<<"$startup_output"; then
  echo "runtime image did not fail closed through application configuration" >&2
  printf '%s\n' "$startup_output" >&2
  exit 1
fi

printf 'Phase 17 deploy artifact proof passed for revision %s\n' "$revision"
