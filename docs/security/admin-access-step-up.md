# Admin Access MFA / step-up boundary

## Status

This document defines the provider/runtime contract for Control Center mutation authentication.
It does **not** by itself prove that Cloudflare Zero Trust is configured correctly in an external
environment. F2.6 can only be closed after the provider configuration is inspected and evidenced.

## Security objective

Ordinary administrative reads and mutation preparation must not rely on the same Cloudflare
Access application audience in staging or production.

The runtime accepts:

- `ADMIN_ACCESS_AUDIENCE` for the standard administrative Access application;
- `ADMIN_ACCESS_PRIVILEGED_AUDIENCE` for the privileged mutation Access application.

The audiences must be distinct. The origin verifies the exact audience cryptographically; no
client-provided `mfa`, `stepUp`, role, capability, or similar boolean is trusted.

## Cloudflare Access topology

Use two Access applications on the same administrative hostname:

1. Standard application: protects the normal Control Center administrative surface.
2. Privileged application: protects the more-specific mutation path `/admin/v1/operations/*`.

Cloudflare evaluates a more-specific application path independently. Therefore the privileged
application must repeat every identity/device rule that is required for administrative access;
it must not assume that the broader application policy is inherited.

The privileged application must not contain a Bypass policy.

## MFA requirement

The privileged Access application/policy must require provider-backed MFA before Cloudflare
issues the privileged application token. Supported provider choices include Cloudflare Access
Independent MFA or an identity-provider MFA policy supported by the selected IdP.

Choose an authentication duration appropriate for privileged administration. A very short MFA
session or Cloudflare's provider option that requires authentication on every Access login may be
used for high-risk environments, but this is an Access-login guarantee, not a claim that every
HTTP request triggers a fresh MFA prompt.

The backend intentionally does not infer independent-MFA completion from an undocumented JWT
claim. Its cryptographic assertion is that the request carries a valid token for the distinct
privileged Access application audience; the provider policy is responsible for making issuance
of that audience conditional on MFA.

## Origin behavior

`GET /admin/v1/session` and read routes authenticate with the standard audience.

`POST /admin/v1/operations/prepare` authenticates only with the privileged audience. There is no
fallback to the standard authenticator. If the privileged authenticator is not configured,
PREPARE fails closed with an authentication error.

The HTTP surface remains READ + PREPARE only. This step-up boundary does not expose simulate,
confirm, approve, or apply over HTTP.

## Environment rules

When the Admin API is enabled:

- staging and production require `ADMIN_ACCESS_PRIVILEGED_AUDIENCE`;
- the privileged audience must differ from `ADMIN_ACCESS_AUDIENCE`;
- development/test may omit the privileged audience so read-only composition remains possible,
  but PREPARE then remains unavailable by design.

## Provider evidence required before F2.6 promotion

Capture evidence for each deployed administrative environment showing all of the following:

1. the standard and privileged Access applications are distinct;
2. the privileged application path covers `/admin/v1/operations/*` and is more specific than the
   standard application path;
3. the privileged application uses the audience configured as
   `ADMIN_ACCESS_PRIVILEGED_AUDIENCE`;
4. the privileged policy contains the required administrator identity/device rules and no Bypass;
5. Independent MFA or the selected IdP MFA requirement is enabled for the privileged policy;
6. a standard-audience token cannot reach mutation PREPARE;
7. a privileged token issued after the MFA ceremony can reach PREPARE;
8. no provider secret, raw Access JWT, cookie, or token fingerprint is placed in Git, Drive,
   screenshots, CI logs, or operator notes.

Until this evidence exists, the code may be green while F2.6 remains canonically open.
