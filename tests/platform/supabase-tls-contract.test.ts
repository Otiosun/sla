import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoFile = (path: string) => new URL(`../../${path}`, import.meta.url);

describe("Supabase staging TLS contract", () => {
  it("requires verify-full and a pinned CA for temporary-access JIT", () => {
    const script = readFileSync(
      repoFile("scripts/operations/staging-database-release-supabase-jit.sh"),
      "utf8",
    );

    expect(script).toContain("sslmode=verify-full");
    expect(script).toContain("DATABASE_SSL_ROOT_CERT_FILE");
    expect(script).not.toContain("sslmode=require");
  });

  it("versions the exact Supabase Root 2021 CA", () => {
    const certificateUrl = repoFile("certs/supabase/prod-ca-2021.crt");
    expect(existsSync(certificateUrl)).toBe(true);

    const certificate = new X509Certificate(readFileSync(certificateUrl));
    expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
    expect(certificate.issuer).toContain("CN=Supabase Root 2021 CA");
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
  });

  it("packages the pinned CA into the immutable runtime image", () => {
    const dockerfile = readFileSync(repoFile("Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      "COPY --chown=node:node certs/supabase/prod-ca-2021.crt ./certs/supabase/prod-ca-2021.crt",
    );
    expect(dockerfile).toContain("ENV NODE_EXTRA_CA_CERTS=/app/certs/supabase/prod-ca-2021.crt");
  });

  it("keeps the Railway provider-live smoke on pinned verify-full TLS", () => {
    const workflow = readFileSync(
      repoFile(".github/workflows/railway-staging-runtime-deploy.yml"),
      "utf8",
    );
    const smokeStep = workflow
      .split("      - name: Prove exact provider-live post-deploy smoke\n", 2)[1]
      ?.split("\n      - name:", 1)[0];

    expect(smokeStep).toBeDefined();
    expect(smokeStep).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/certs/supabase/prod-ca-2021.crt",
    );
    expect(smokeStep).toContain(
      "PGSSLROOTCERT: ${{ github.workspace }}/certs/supabase/prod-ca-2021.crt",
    );
    expect(smokeStep).toContain('url.searchParams.get("sslmode") !== "verify-full"');
    expect(smokeStep).toContain("STAGING_RUNTIME_DATABASE_URL must use sslmode=verify-full");
    expect(smokeStep).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(smokeStep).not.toContain("rejectUnauthorized: false");
  });
});
