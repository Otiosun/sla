#!/usr/bin/env bash
set -Eeuo pipefail

workflow=".github/workflows/publish-runtime-image.yml"

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

[[ -f "$workflow" ]] || fail "missing ${workflow}"

# Publishing is canonical-main only: WIP/gate branches never mutate the registry.
require_literal "$workflow" "branches: [main]"
require_literal "$workflow" "workflow_dispatch:"
require_literal "$workflow" "refs/heads/main"
reject_literal "$workflow" '"gate/**"'

# Least privilege for GHCR, with no broad repository write access.
require_literal "$workflow" "contents: read"
require_literal "$workflow" "packages: write"
reject_literal "$workflow" "contents: write"

# An image publish must not be cancelled half-way through registry mutation.
require_literal "$workflow" "cancel-in-progress: false"

# Registry and tags are derived from trusted GitHub context, never committed credentials.
require_literal "$workflow" "ghcr.io"
require_literal "$workflow" 'sha-${GITHUB_SHA}'
require_literal "$workflow" 'docker login ghcr.io'
require_literal "$workflow" 'password-stdin'
require_literal "$workflow" 'secrets.GITHUB_TOKEN'
reject_literal "$workflow" "ghp_"
reject_literal "$workflow" "github_pat_"

# Provenance/SBOM attestations require a non-default BuildKit-backed buildx driver.
# GitHub-hosted runners otherwise use the docker driver, which rejects attestations.
require_literal "$workflow" 'docker buildx create --driver docker-container --use'
require_literal "$workflow" 'docker buildx inspect --bootstrap'

# Exact source revision is embedded and the published manifest gets supply-chain metadata.
require_literal "$workflow" 'org.opencontainers.image.revision=${GITHUB_SHA}'
require_literal "$workflow" "--provenance=mode=max"
require_literal "$workflow" "--sbom=true"
require_literal "$workflow" "--push"
require_literal "$workflow" 'docker buildx imagetools inspect'

# Mutable convenience tag may exist, but immutable SHA tag is mandatory and verified.
require_literal "$workflow" ':main'
require_literal "$workflow" 'sha-${GITHUB_SHA}'

printf 'Phase 17 runtime image publish contract proof passed.\n'
