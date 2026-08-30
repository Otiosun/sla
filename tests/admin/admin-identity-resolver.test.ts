import { describe, expect, it } from "vitest";
import {
  AdminIdentityResolver,
  toCloudflareAccessIdentityRef,
  type AdminPrincipalIdentityRecord,
  type AdminPrincipalIdentityRepository,
} from "../../src/adapters/admin-api/identity-resolver.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const ISSUER = "https://pokemon-rpg.cloudflareaccess.com";
const SUBJECT = "stable-access-subject";

class FakeIdentityRepository implements AdminPrincipalIdentityRepository {
  public constructor(private readonly records: readonly AdminPrincipalIdentityRecord[]) {}

  public async findByIdentityRef(
    identityRef: string,
  ): Promise<AdminPrincipalIdentityRecord | null> {
    return this.records.find((record) => record.identityRef === identityRef) ?? null;
  }
}

function identity(email: string) {
  return {
    provider: "cloudflare-access" as const,
    issuer: ISSUER,
    subject: SUBJECT,
    email,
  };
}

describe("AdminIdentityResolver", () => {
  it("uses verified Access subject instead of email as the authority key", async () => {
    const identityRef = toCloudflareAccessIdentityRef(identity("original@example.com"));
    const resolver = new AdminIdentityResolver(
      new FakeIdentityRepository([{ principalId: PRINCIPAL_ID, identityRef, status: "ACTIVE" }]),
      "staging",
    );

    const resolved = await resolver.resolve(identity("attacker-controlled-display@example.com"));

    expect(resolved).toEqual({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      identityRef,
      displayEmail: "attacker-controlled-display@example.com",
    });
  });

  it("denies a disabled internal principal even when external identity is valid", async () => {
    const identityRef = toCloudflareAccessIdentityRef(identity("admin@example.com"));
    const resolver = new AdminIdentityResolver(
      new FakeIdentityRepository([{ principalId: PRINCIPAL_ID, identityRef, status: "DISABLED" }]),
      "production",
    );

    await expect(resolver.resolve(identity("admin@example.com"))).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Administrative access denied",
    });
  });

  it("denies unknown identities with the same public error as disabled principals", async () => {
    const resolver = new AdminIdentityResolver(new FakeIdentityRepository([]), "production");

    await expect(resolver.resolve(identity("unknown@example.com"))).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Administrative access denied",
    });
  });

  it("rejects non-Cloudflare Access issuers before principal lookup", async () => {
    const resolver = new AdminIdentityResolver(new FakeIdentityRepository([]), "staging");

    await expect(
      resolver.resolve({
        provider: "cloudflare-access",
        issuer: "https://example.com",
        subject: SUBJECT,
        email: "admin@example.com",
      }),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });
});
