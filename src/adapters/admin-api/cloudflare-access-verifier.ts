import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { CloudflareAccessIdentity } from "./identity-resolver.js";

const JwtHeaderSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().trim().min(1).max(256),
  typ: z.literal("JWT").optional(),
});

const JwtClaimsSchema = z.object({
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  email: z.string().email().max(320).optional(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  nbf: z.number().int().positive(),
  iss: z.string().url(),
  sub: z.string().trim().min(1).max(256),
  type: z.literal("app"),
});

const JwkSchema = z.object({
  kid: z.string().trim().min(1).max(256),
  kty: z.literal("RSA"),
  alg: z.literal("RS256"),
  use: z.literal("sig"),
  e: z.string().min(1),
  n: z.string().min(1),
});

const JwksSchema = z.object({
  keys: z.array(JwkSchema).min(1),
});

export interface CloudflareAccessVerifierConfig {
  readonly teamDomain: string;
  readonly audience: string;
  readonly clockSkewSeconds?: number;
  readonly jwksCacheTtlMs?: number;
  readonly fetchTimeoutMs?: number;
}

interface CachedJwk {
  readonly key: ReturnType<typeof createPublicKey>;
  readonly expiresAtMs: number;
}

export type AdminAccessTokenVerifier = (token: string) => Promise<CloudflareAccessIdentity>;

function denied(): AdminError {
  return new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Administrative access denied");
}

function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw denied();
  }
}

function normalizeTeamDomain(rawDomain: string): URL {
  let url: URL;
  try {
    url = new URL(rawDomain);
  } catch {
    throw new Error("Cloudflare Access team domain must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".cloudflareaccess.com")) {
    throw new Error("Cloudflare Access team domain must use a cloudflareaccess.com HTTPS host");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Cloudflare Access team domain must not contain path, query, or fragment");
  }
  return url;
}

function audienceMatches(rawAudience: string | readonly string[], expectedAudience: string): boolean {
  return Array.isArray(rawAudience)
    ? rawAudience.includes(expectedAudience)
    : rawAudience === expectedAudience;
}

export class CloudflareAccessJwtVerifier {
  private readonly issuer: string;
  private readonly certsUrl: URL;
  private readonly audience: string;
  private readonly clockSkewSeconds: number;
  private readonly jwksCacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly keyCache = new Map<string, CachedJwk>();

  public constructor(
    config: CloudflareAccessVerifierConfig,
    dependencies: {
      readonly fetchImpl?: typeof fetch;
      readonly now?: () => number;
    } = {},
  ) {
    const teamDomain = normalizeTeamDomain(config.teamDomain);
    this.issuer = teamDomain.origin;
    this.certsUrl = new URL("/cdn-cgi/access/certs", teamDomain);
    this.audience = z.string().trim().min(1).max(256).parse(config.audience);
    this.clockSkewSeconds = z.number().int().min(0).max(300).parse(config.clockSkewSeconds ?? 30);
    this.jwksCacheTtlMs = z
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .parse(config.jwksCacheTtlMs ?? 300_000);
    this.fetchTimeoutMs = z
      .number()
      .int()
      .min(250)
      .max(10_000)
      .parse(config.fetchTimeoutMs ?? 3_000);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  public async verify(token: string): Promise<CloudflareAccessIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw denied();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw denied();

    const header = JwtHeaderSchema.safeParse(decodeJsonSegment(encodedHeader));
    const claims = JwtClaimsSchema.safeParse(decodeJsonSegment(encodedPayload));
    if (!header.success || !claims.success) throw denied();

    this.assertClaims(claims.data);
    const key = await this.resolveKey(header.data.kid);
    const signature = Buffer.from(encodedSignature, "base64url");
    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    if (!verify("RSA-SHA256", signingInput, key, signature)) throw denied();

    return {
      provider: "cloudflare-access",
      issuer: claims.data.iss,
      subject: claims.data.sub,
      email: claims.data.email,
    };
  }

  private assertClaims(claims: z.infer<typeof JwtClaimsSchema>): void {
    const nowSeconds = Math.floor(this.now() / 1_000);
    if (claims.iss !== this.issuer) throw denied();
    if (!audienceMatches(claims.aud, this.audience)) throw denied();
    if (claims.exp <= nowSeconds - this.clockSkewSeconds) throw denied();
    if (claims.nbf > nowSeconds + this.clockSkewSeconds) throw denied();
    if (claims.iat > nowSeconds + this.clockSkewSeconds) throw denied();
  }

  private async resolveKey(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const cached = this.keyCache.get(kid);
    if (cached && cached.expiresAtMs > this.now()) return cached.key;

    await this.refreshKeys();
    const refreshed = this.keyCache.get(kid);
    if (!refreshed || refreshed.expiresAtMs <= this.now()) throw denied();
    return refreshed.key;
  }

  private async refreshKeys(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetchImpl(this.certsUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw denied();
      const jwks = JwksSchema.safeParse(await response.json());
      if (!jwks.success) throw denied();

      const expiresAtMs = this.now() + this.jwksCacheTtlMs;
      const next = new Map<string, CachedJwk>();
      for (const jwk of jwks.data.keys) {
        next.set(jwk.kid, {
          key: createPublicKey({ key: jwk, format: "jwk" }),
          expiresAtMs,
        });
      }
      this.keyCache.clear();
      for (const [kid, value] of next) this.keyCache.set(kid, value);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw denied();
    } finally {
      clearTimeout(timeout);
    }
  }
}
