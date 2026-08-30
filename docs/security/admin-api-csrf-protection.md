# Admin API CSRF protection contract

Status: active for the Pokémon Control Center Admin API.

## Why CSRF applies

The initial administrative perimeter uses Cloudflare Access. Browser authentication is cookie-backed at the Access layer and the verified Access assertion reaches the origin separately. Therefore an authenticated browser can carry credentials automatically, and unsafe administrative HTTP methods require an explicit CSRF defense in addition to authentication and authorization.

## Current contract

Every unsafe Admin API request (`POST`, `PUT`, `PATCH`, `DELETE`) must satisfy all of these conditions before authentication, rate limiting, or a domain handler is reached:

1. `Origin` is present and exactly equals the configured Control Center origin.
2. The request includes `X-Control-Center-CSRF: 1`.
3. Credentialed CORS is emitted only for that exact configured origin.
4. Preflight exposes only the headers required by the current mutation surface. For `POST /admin/v1/operations/prepare`, the allowlist is `content-type,x-control-center-csrf`.

The browser client adds the custom header automatically for Admin API mutation requests. It does not receive, read, or inject the Cloudflare Access assertion.

## Security semantics of the custom header

`X-Control-Center-CSRF: 1` is an explicit request guard, not a secret synchronizer token and not an authority credential. Its static value is intentional.

The defense relies on browser enforcement:

- ordinary cross-site form submissions cannot add the custom header;
- adding the custom header from cross-origin JavaScript triggers CORS preflight;
- the Admin API permits credentialed CORS only for the exact configured Control Center origin;
- wildcard origins are not permitted.

A non-browser caller being able to spell the header does not grant administrative authority. It still needs a valid Access assertion, an ACTIVE internal principal, required Registry capability/scope, mutation admission, and all operation risk-policy gates.

## Ordering and fail-closed behavior

For unsafe methods the transport boundary evaluates Origin and the CSRF guard before invoking:

- Cloudflare Access request authentication;
- PostgreSQL Admin API rate limiting;
- mutation admission/idempotency;
- AdminMutationFacade;
- AdminService / Admin Operation Registry;
- any domain owner.

Missing or invalid Origin or CSRF guard returns a sanitized authorization denial and the protected handler is not called.

## Scope

The current HTTP mutation surface remains prepare-only:

- `OPTIONS /admin/v1/operations/prepare`
- `POST /admin/v1/operations/prepare`

There are no HTTP routes for `simulate`, `confirm`, `approve`, or `apply` in this slice. Any future unsafe Admin API route inherits the transport-level guard and must add route-specific tests before exposure.

## Test requirements

The canonical tests must prove at minimum:

- valid exact-origin request with the custom guard is accepted by the transport boundary;
- missing guard is denied before authentication;
- incorrect guard is denied before authentication;
- missing or mismatched Origin is denied before authentication;
- exact-origin preflight allows the custom guard header;
- client mutation requests include the guard while keeping authority fields and provider tokens out of the browser payload;
- the PostgreSQL AdminOperation correlation E2E continues to pass through the same guarded HTTP boundary.

## Re-evaluation triggers

This contract must be revisited if any of these change:

- authentication moves away from Cloudflare Access or changes cookie behavior;
- the Control Center and Admin API deployment topology changes materially;
- multiple trusted browser origins are introduced;
- an app-owned server session is introduced;
- a future route requires a different request transport.

Fetch Metadata (`Sec-Fetch-Site` and related headers) may be added as defense in depth after the final deployment topology is fixed. It is not a substitute for exact Origin validation and the custom-request-header gate.
