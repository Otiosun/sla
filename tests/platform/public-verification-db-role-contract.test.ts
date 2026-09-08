import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function read(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("public verification PostgreSQL least-privilege contract", () => {
  it("provisions a dedicated non-privileged login separately from the generic runtime", async () => {
    const sql = await read("db/bootstrap/public_verification_role.sql");

    expect(sql).toContain("public_verification_role");
    expect(sql).toContain("public_verification_password");
    expect(sql).toMatch(/NOSUPERUSER/i);
    expect(sql).toMatch(/NOCREATEDB/i);
    expect(sql).toMatch(/NOCREATEROLE/i);
    expect(sql).toMatch(/NOREPLICATION/i);
    expect(sql).toMatch(/NOBYPASSRLS/i);
    expect(sql).toMatch(/GRANT CONNECT/i);
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA public/i);
    expect(sql).toMatch(/REVOKE CREATE ON SCHEMA public/i);
  });

  it("grants only verification reads and durable rate-limit writes", async () => {
    const sql = await read("db/bootstrap/public_verification_grants.sql");

    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public/i);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.schema_migrations/i);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.trainer_card_verifications/i);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.public_verification_rate_limit_buckets/i,
    );
    expect(sql).not.toMatch(/GRANT[^;]*(players|wallet|inventory|admin_|audit_events)/i);
  });

  it("runs a real CI database proof that denied domain access fails closed", async () => {
    const workflow = await read(
      ".github/workflows/public-verification-db-least-privilege.yml",
    );

    expect(workflow).toContain("Public verification database least-privilege proof");
    expect(workflow).toContain("public_verification_role.sql");
    expect(workflow).toContain("public_verification_grants.sql");
    expect(workflow).toContain("trainer_card_verifications");
    expect(workflow).toContain("public_verification_rate_limit_buckets");
    expect(workflow).toContain("public verifier unexpectedly has domain table access");
    expect(workflow).toContain("public verifier unexpectedly can mutate trainer cards");
    expect(workflow).toContain("public verifier unexpectedly can execute DDL");
  });
});
