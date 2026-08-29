# Dependency and supply-chain update policy

This repository treats dependency updates as code changes, not as unattended maintenance.

## Current invariants

- Runtime, development tools, Node and pnpm are pinned to exact versions.
- GitHub Actions are pinned by commit SHA.
- `saveExact: true` and `engineStrict: true` remain enabled.
- Package install/build scripts are denied by default and must appear in the explicit `allowBuilds` policy before execution.
- `pnpm install --frozen-lockfile` is required in CI.
- Production dependencies are audited for HIGH/CRITICAL advisories in the permanent security-integrity proof.

## Update cadence

Dependabot checks npm/pnpm and GitHub Actions weekly. Dependabot PRs are review inputs only: they must never auto-merge and do not bypass the normal WIP -> clean candidate -> post-merge proof protocol.

## Release blocking policy

A known HIGH or CRITICAL advisory in a production dependency blocks promotion unless one of the following is true and documented in the PR:

1. the dependency is upgraded to a non-vulnerable exact version;
2. the vulnerable package is removed from the production dependency graph; or
3. the advisory is demonstrably unreachable in this runtime and an explicit time-bounded exception is approved by the security owner.

Exceptions must record advisory identifier, affected path, reachability evidence, owner, expiry date and remediation plan. Suppressing an audit solely to make CI green is prohibited.

## Review checklist

For every dependency update:

1. inspect upstream release notes and security advisories;
2. inspect lockfile changes and newly introduced transitive packages;
3. verify install/build scripts remain inside the explicit allowlist;
4. run lint, format, typecheck, unit tests and all permanent PostgreSQL proofs;
5. verify provider boundaries remain isolated from domain modules;
6. promote only the exact tree that passed all permanent gates.

## Emergency security patch

For an actively exploitable issue, create a minimal WIP from current `main`, update/remove the affected package, run all permanent gates, reproduce the proven tree in a one-commit clean candidate, merge with expected-head protection, then require all post-merge gates before deployment.
