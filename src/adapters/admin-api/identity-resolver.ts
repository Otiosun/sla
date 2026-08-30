import { z } from "zod";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";

const CloudflareAccessIdentitySchema = z
  .object({
    provider: z.literal("cloudflare-access"),
    issuer: z.string().url().max(512),
    subject: z.string().trim().min(1).max(256),
    email: z.string().email().max(320).optional(),
  })
  .strict();

export type CloudflareAccessIdentity = z.infer<typeof CloudflareAccessIdentitySchema>;

export interface AdminPrincipalIdentityRecord {
  readonly principalId: string;
  readonly identityRef: string;
  readonly status: "ACTIVE" | "DISABLED";
}

export interface AdminPrincipalIdentityRepository {
  findByIdentityRef(identityRef: string): Promise<AdminPrincipalIdentityRecord | null>;
}

export interface ResolvedAdminIdentityContext {
  readonly principalId: string;
  readonly environment: "development" | "staging" | "production";
  readonly identityRef: string;
  readonly displayEmail: string | null;
}

function normalizeAccessIssuerHost(rawIssuer: string): string {
  const issuer = new URL(rawIssuer);
  if (issuer.protocol !== "https:") {
    throw new AdminError(
      ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      "Invalid admin identity assertion",
    );
  }
  const host = issuer.hostname.toLowerCase();
  if (!host.endsWith(".cloudflareaccess.com")) {
    throw new AdminError(
      ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      "Invalid admin identity assertion",
    );
  }
  return host;
}

export function toCloudflareAccessIdentityRef(rawIdentity: unknown): string {
  const parsed = CloudflareAccessIdentitySchema.safeParse(rawIdentity);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      "Invalid admin identity assertion",
    );
  }

  const host = normalizeAccessIssuerHost(parsed.data.issuer);
  return `cloudflare-access:${host}:${encodeURIComponent(parsed.data.subject)}`;
}

export class AdminIdentityResolver {
  public constructor(
    private readonly repository: AdminPrincipalIdentityRepository,
    private readonly environment: "development" | "staging" | "production",
  ) {}

  public async resolve(rawIdentity: unknown): Promise<ResolvedAdminIdentityContext> {
    const identity = CloudflareAccessIdentitySchema.safeParse(rawIdentity);
    if (!identity.success) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Administrative access denied");
    }

    const identityRef = toCloudflareAccessIdentityRef(identity.data);
    const principal = await this.repository.findByIdentityRef(identityRef);

    if (principal === null || principal.status !== "ACTIVE") {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Administrative access denied");
    }

    return {
      principalId: principal.principalId,
      environment: this.environment,
      identityRef,
      displayEmail: identity.data.email ?? null,
    };
  }
}
