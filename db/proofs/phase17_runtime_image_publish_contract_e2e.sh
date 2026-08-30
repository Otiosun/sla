#!/usr/bin/env bash
set -Eeuo pipefail

contract_workflow=".github/workflows/runtime-image-publish-contract-proof.yml"
legacy_workflow=".github/workflows/publish-runtime-image.yml"

fail() {
  printf 'runtime image publish contract failed: %s\n' "$1" >&2
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

[[ -f "$contract_workflow" ]] || fail "missing ${contract_workflow}"
[[ -f "$legacy_workflow" ]] || fail "missing ${legacy_workflow}"

# The workflow empirically observed to run on every canonical push owns publication.
require_literal "$contract_workflow" "Runtime Image Publish Contract Proof"
require_literal "$contract_workflow" "push:"
require_literal "$contract_workflow" "pull_request:"
require_literal "$contract_workflow" "packages: write"
require_literal "$contract_workflow" "publish:"
require_literal "$contract_workflow" "immutable OCI runtime image"
require_literal "$contract_workflow" "github.event_name == 'push'"
require_literal "$contract_workflow" "github.ref == 'refs/heads/main'"
require_literal "$contract_workflow" "cancel-in-progress: false"

# Registry coordinates and credentials come only from trusted GitHub context.
require_literal "$contract_workflow" "ghcr.io"
require_literal "$contract_workflow" 'sha-${GITHUB_SHA}'
require_literal "$contract_workflow" ':main'
require_literal "$contract_workflow" 'docker login ghcr.io'
require_literal "$contract_workflow" 'password-stdin'
require_literal "$contract_workflow" 'secrets.GITHUB_TOKEN'
reject_literal "$contract_workflow" "ghp_"
reject_literal "$contract_workflow" "github_pat_"

# The build must be attestation-capable and publish SBOM + provenance.
require_literal "$contract_workflow" 'docker buildx create --driver docker-container --use'
require_literal "$contract_workflow" 'docker buildx inspect --bootstrap'
require_literal "$contract_workflow" 'org.opencontainers.image.revision=${GITHUB_SHA}'
require_literal "$contract_workflow" "--provenance=mode=max"
require_literal "$contract_workflow" "--sbom=true"
require_literal "$contract_workflow" "--push"

# Both mutable convenience and immutable tags must resolve to the same sha256 manifest.
# Registry reads are allowed a short bounded retry window because GHCR may not expose a freshly
# pushed manifest immediately. The verifier must still fail closed after the final attempt.
require_literal "$contract_workflow" 'resolve_manifest_digest()'
require_literal "$contract_workflow" 'for attempt in {1..6}; do'
require_literal "$contract_workflow" 'docker buildx imagetools inspect'
require_literal "$contract_workflow" 'sleep $((attempt * 2))'
require_literal "$contract_workflow" 'return 1'
require_literal "$contract_workflow" 'main_digest'
require_literal "$contract_workflow" 'immutable_digest'
require_literal "$contract_workflow" 'main_digest" == "$immutable_digest'
require_literal "$contract_workflow" 'runtime image published:'

# The old workflow remains only as an explicit recovery surface, never a second automatic publisher.
require_literal "$legacy_workflow" "workflow_dispatch:"
reject_literal "$legacy_workflow" "  push:"

printf 'Phase 17 runtime image publish contract proof passed.\n'
