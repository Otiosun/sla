# Admin Control Plane — Authentication Protocol v0.1

Status: canonical candidate implemented as provider boundary; no public HTTP endpoint yet.

## Decision

Cloudflare Access is the initial identity/perimeter provider for the Pokémon Control Center.

Cloudflare proves that a human authenticated to the protected administrative application. The Pokémon backend remains the sole authority for whether that identity is an administrator and which roles, capabilities and scopes it owns.

The chain is:

`Browser -> Cloudflare Access -> verified Access application JWT -> identity_ref -> admin_principals -> Admin Registry / Player360`

## Identity rule

For identity-based Access tokens, the stable authority input is the verified JWT `sub`, not the email address.

Canonical identity reference format:

`cloudflare-access:<team-host>:<sub>`

Example shape only:

`cloudflare-access:example.cloudflareaccess.com:7335d417-61da-459d-899c-0a01c76a2f94`

The team host is normalized to lowercase and the subject is used only after JWT verification.

Email may be carried as display/support metadata but MUST NOT select an `admin_principal`.

Service-token Access JWTs are not accepted as interactive admin identities because their `sub` is empty. Machine-to-machine administration, if ever required, gets a separate protocol and capability model.

## Required JWT verification

The origin must validate the complete `Cf-Access-Jwt-Assertion` application token before trusting claims, unless a later deployment architecture provides an equivalent cryptographically verified boundary that is explicitly documented.

Validation must include at least:

- RS256 signature using the configured Cloudflare Access issuer's published keys;
- expected issuer;
- expected application audience (AUD);
- expiration / not-before / issued-at handling supported by the verifier;
- token type appropriate for the application;
- non-empty subject for interactive users.

Reading the header or decoding an unsigned payload is forbidden.

## Principal resolution

After a JWT is verified:

1. derive the provider-qualified `identity_ref` from verified issuer host + `sub`;
2. query `admin_principals.identity_ref`;
3. require principal status `ACTIVE`;
4. create trusted server context `{ principalId, environment }`;
5. every request still re-authorizes through the canonical Admin Registry / Player360 service.

A valid Cloudflare identity that has no active internal `admin_principal` receives the same generic denial as a disabled principal. Do not leak provisioning state.

## Environment

Environment is server/deployment configuration and never a JWT/client-controlled selector.

Staging and production use distinct Access application audiences and distinct backend configuration/secrets. They may live in the same Zero Trust organization, but an application token for one audience must not be accepted by the other.

## MFA and sessions

MFA is required at the Access policy for all interactive administrators initially. This is a baseline control, not a replacement for risk-tier policy.

Access session expiration and revocation are the initial revocable external session mechanism. Independently, setting `admin_principals.status = DISABLED` removes RPG authorization even if an Access token is otherwise valid.

Per-action step-up for R4 operations remains a separate requirement. Do not claim application-entry MFA alone satisfies R4 step-up.

## Logout / revocation

The Control Center logout flow must terminate/redirect through the Access logout mechanism when integrated. Internal administrative disable remains a second kill switch.

## Authorization separation

Cloudflare Access policies decide who may reach the protected application perimeter.

They DO NOT carry or decide Pokémon RPG roles/capabilities/scopes. Those remain in PostgreSQL and the Admin Registry.

Do not map Cloudflare groups directly into mechanical capabilities at request time.

## Implementation sequence

1. provider-neutral verified identity contract;
2. `identity_ref` derivation and ACTIVE principal resolver;
3. PostgreSQL identity lookup;
4. tests for email spoofing, unknown identity and disabled principal;
5. JWT verifier adapter using a maintained JOSE implementation;
6. Fastify preHandler/session-context integration;
7. `/admin/v1/session` read endpoint;
8. read-only Player 360 routes;
9. only then consider mutation endpoints.
