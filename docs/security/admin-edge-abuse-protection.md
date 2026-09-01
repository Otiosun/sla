# Admin edge / pre-auth abuse protection

## Status

This document defines the provider/deployment contract required to close Control Center checklist item
F2.11. The backend already has a durable PostgreSQL post-auth rate limiter per authenticated principal
and operation. That limiter is necessary but is intentionally **not** treated as protection against
unauthenticated brute force, request floods, or direct-origin bypass.

This document does not by itself prove that Cloudflare or the origin deployment is configured correctly.
F2.11 remains open until the provider and origin evidence listed below exists.

## Threat model

The edge layer must absorb traffic before the Node.js Admin API spends work on JWT verification,
identity resolution, PostgreSQL session checks, or request handlers.

The protected cases include:

- repeated invalid/missing Access assertions;
- credential stuffing and brute-force traffic against the administrative hostname;
- volumetric or high-rate requests to Admin API paths;
- direct requests to a discovered origin address that bypass Cloudflare Access/WAF/rate limiting;
- abusive authenticated traffic that gets through the edge but exceeds an operator's normal API budget.

The existing PostgreSQL limiter covers only the final case. The provider/edge must cover the first four.

## Required layers

### 1. Cloudflare Access before the origin

The administrative hostname must remain protected by Cloudflare Access. The standard and privileged
Access application split documented in `admin-access-step-up.md` remains authoritative.

Do not create an origin path that skips Access for convenience.

### 2. Cloudflare WAF rate limiting before authentication reaches the origin

Create Cloudflare rate limiting rules for the administrative hostname and Admin API paths. Rules must be
provider-side and execute before the origin.

At minimum, maintain separate budgets for:

- the administrative hostname as a whole, to cap abusive clients before origin work;
- `/admin/v1/operations/*`, with a stricter budget than ordinary read traffic;
- authentication/verification failure traffic where the selected Cloudflare plan/rule expression can
  safely count it.

Exact numeric budgets are operational configuration, not domain authority, and must be tuned from staging
telemetry. Do not copy the backend per-principal values as edge/IP budgets: they measure different actors
and different threats.

Prefer a block or managed challenge appropriate to the administrative use case. Administrative APIs must
not silently fail open when a rate-limit rule is unavailable.

### 3. Origin must not be bypassable

Use one of these mutually exclusive origin topologies:

#### Preferred when compatible: Cloudflare Tunnel

Run the administrative origin behind Cloudflare Tunnel so the service is reached through an outbound-only
connector and does not require a publicly routable origin listener for the administrative hostname.

When Tunnel's Access validation is enabled in `cloudflared`, configure the correct Access application AUD
tags; origin application JWT verification remains defense in depth and must not be removed merely because
the connector also validates Access.

#### Alternative: public origin + authenticated origin protection

If the deployment cannot use Tunnel, the public origin must reject traffic that did not traverse the
Cloudflare edge. Use Authenticated Origin Pulls with an account/hostname-specific certificate where the
hosting topology supports mTLS, or an equivalently strong platform-native restriction/ACL that is proven
to admit only Cloudflare-originated traffic.

A globally shared Cloudflare AOP certificate proves only that traffic came from the Cloudflare network;
prefer a zone/hostname-specific credential when possible.

## Explicitly forbidden shortcuts

- Do not trust `CF-Connecting-IP`, `X-Forwarded-For`, `True-Client-IP`, or another forwarding header as a
  security identity unless the network boundary already guarantees that only the trusted proxy can reach
  the origin.
- Do not implement a Node.js pre-auth limiter keyed by a client-controlled forwarding header and call
  F2.11 complete.
- Do not expose a second unprotected origin hostname/port for the Admin API.
- Do not treat the PostgreSQL post-auth limiter as brute-force protection.
- Do not put Cloudflare API tokens, Tunnel credentials, AOP private keys, Access JWTs, or cookies in Git,
  Drive, screenshots, CI logs, or application logs.
- Do not use IP allow rules that bypass WAF/rate-limiting rules as a broad administrative allowlist.

## Existing post-auth layer

`PostgresAdminApiRateLimiter` remains the authenticated abuse layer. Its current default budgets are keyed
by `(principal_id, operation)` and shared across API instances:

- `session.read`: 120 / 60 s;
- `player.search`: 60 / 60 s;
- `player.read`: 120 / 60 s;
- `mutation.prepare`: 60 / 60 s.

These values constrain authenticated operator traffic after durable-session authorization. They are not
edge budgets and must not be reused mechanically for IP/client rate limiting.

## Evidence required before F2.11 promotion

For every administrative staging/production environment, capture non-secret evidence proving:

1. the public administrative hostname is proxied through Cloudflare and protected by Access;
2. provider-side rate limiting exists for the administrative host/API and the privileged operations path;
3. excessive unauthenticated traffic is blocked/challenged at Cloudflare before reaching Node/PostgreSQL;
4. the origin topology is either Cloudflare Tunnel with no bypassable public administrative listener, or
   a public origin protected by AOP/equivalent network control;
5. a direct-origin request that bypasses the Cloudflare hostname cannot reach the Admin API;
6. ordinary authorized traffic still reaches the standard Access boundary;
7. privileged PREPARE traffic still reaches the separate privileged Access boundary;
8. the PostgreSQL post-auth limiter still returns 429/Retry-After when an authenticated principal exceeds
   its operation budget;
9. no secret/token/key is present in the evidence.

Until these checks are executed against the deployed environment, F2.11 remains canonically open even if
all repository tests are green.
