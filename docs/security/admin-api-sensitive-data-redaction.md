# Admin API — Sensitive data redaction policy

Status: canonical for the current read-only Player 360 surface.

## Purpose

Sensitive Player 360 data must not become visible merely because a repository, adapter, or future implementation returns a broader object than intended. Authorization and redaction are enforced at the service boundary before data reaches the Admin API response.

## Current sensitive fields

For the current Player 360 contract, the following fields are classified as sensitive:

- `profile.metadata`
- `identities[].externalId`

This list is intentionally explicit. Adding another sensitive field to Player 360 requires updating this policy and the corresponding adversarial tests before exposing it through the Admin API.

## Ordinary reads

A normal Player 360 read/search is not allowed to expose the sensitive fields above.

The service boundary must return:

- `profile.metadata = null`
- every `identities[].externalId = null`

This redaction must occur even if the underlying repository returns populated sensitive values. Repository-side minimization remains useful defense in depth, but it is not the final security boundary.

## Sensitive reads

Sensitive data may be returned only after the dedicated capability path is authorized server-side:

- player detail: `player.read` plus `player.read_sensitive`
- player search: `player.search` plus `player.search_sensitive`

The browser does not grant these capabilities and cannot promote an ordinary request into a sensitive request by supplying principal, roles, capabilities, scopes, or environment.

Identity lookup by provider/external ID remains a sensitive search path and must use the sensitive authorization contract.

## Enforcement layers

1. The persistence adapter minimizes sensitive fields when `includeSensitive=false`.
2. `Player360Service` independently redacts the sensitive fields before returning ordinary reads/searches.
3. The Admin API exposes only the service result; it does not reconstruct or bypass sensitive fields.
4. Adversarial service tests deliberately use a repository that leaks sensitive values and prove that ordinary responses still redact them.

## Change rule

A new Player 360 field must be classified before it is exposed administratively. If it is sensitive, the change is incomplete until all of the following are true:

- the field is listed here;
- ordinary output has an explicit redacted representation;
- a capability-controlled sensitive path is defined when disclosure is required;
- an adversarial test proves that a leaky repository cannot bypass the service boundary.
