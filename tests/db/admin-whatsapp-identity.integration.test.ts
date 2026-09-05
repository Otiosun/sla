import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdminWhatsAppIdentityResolver } from "../../src/platform/admin/postgres-admin-whatsapp-identity-resolver.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("PostgresAdminWhatsAppIdentityResolver", () => {
  const dbName = `pokemon_admin_whatsapp_identity_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "admin-whatsapp-identity-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("resolves active AdminPrincipal and role capabilities from a namespaced WhatsApp identity", async () => {
    const principalId = randomUUID();
    const roleId = randomUUID();
    const capabilityId = randomUUID();
    const jid = "5511999999999@s.whatsapp.net";

    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [principalId, `whatsapp:${jid}`],
    );
    await pool.query(
      "INSERT INTO admin_roles(id, slug, name) VALUES ($1, 'RECEPTION_TEST', 'Reception')",
      [roleId],
    );
    await pool.query(
      "INSERT INTO capabilities(id, key, risk_tier) VALUES ($1, 'player.registration.approve', 2)",
      [capabilityId],
    );
    await pool.query("INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)", [
      principalId,
      roleId,
    ]);
    await pool.query(
      "INSERT INTO admin_role_capabilities(role_id, capability_id) VALUES ($1, $2)",
      [roleId, capabilityId],
    );

    const resolver = new PostgresAdminWhatsAppIdentityResolver(pool);

    expect(await resolver.resolvePrincipal({ provider: "baileys", externalId: jid })).toEqual({
      principalId,
    });
    expect(await resolver.capabilitiesFor({ provider: "baileys", externalId: jid })).toEqual([
      "player.registration.approve",
    ]);
  });

  it("fails closed for disabled, unknown and non-WhatsApp identities", async () => {
    const principalId = randomUUID();
    const jid = "5511888888888@s.whatsapp.net";
    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'DISABLED')",
      [principalId, `whatsapp:${jid}`],
    );

    const resolver = new PostgresAdminWhatsAppIdentityResolver(pool);

    expect(await resolver.resolvePrincipal({ provider: "baileys", externalId: jid })).toBeNull();
    expect(await resolver.capabilitiesFor({ provider: "baileys", externalId: jid })).toEqual([]);
    expect(
      await resolver.resolvePrincipal({ provider: "discord", externalId: "same-looking-id" }),
    ).toBeNull();
  });

  it("returns mentionable JIDs only for active requested principals with the required capability", async () => {
    const allowedPrincipal = randomUUID();
    const noCapabilityPrincipal = randomUUID();
    const disabledPrincipal = randomUUID();
    const nonWhatsAppPrincipal = randomUUID();
    const roleId = randomUUID();
    const capabilityId = randomUUID();
    const allowedJid = "5511777777777@s.whatsapp.net";

    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status) VALUES
       ($1, $2, 'ACTIVE'),
       ($3, $4, 'ACTIVE'),
       ($5, $6, 'DISABLED'),
       ($7, $8, 'ACTIVE')`,
      [
        allowedPrincipal,
        `whatsapp:${allowedJid}`,
        noCapabilityPrincipal,
        "whatsapp:5511666666666@s.whatsapp.net",
        disabledPrincipal,
        "whatsapp:5511555555555@s.whatsapp.net",
        nonWhatsAppPrincipal,
        "control-center:staff-1",
      ],
    );
    await pool.query(
      "INSERT INTO admin_roles(id, slug, name) VALUES ($1, 'RECEPTION_MENTION_TEST', 'Reception Mention')",
      [roleId],
    );
    await pool.query(
      "INSERT INTO capabilities(id, key, risk_tier) VALUES ($1, 'player.registration.read', 0)",
      [capabilityId],
    );
    await pool.query(
      `INSERT INTO admin_principal_roles(principal_id, role_id) VALUES
       ($1, $2), ($3, $2), ($4, $2)`,
      [allowedPrincipal, roleId, disabledPrincipal, nonWhatsAppPrincipal],
    );
    await pool.query(
      "INSERT INTO admin_role_capabilities(role_id, capability_id) VALUES ($1, $2)",
      [roleId, capabilityId],
    );

    const resolver = new PostgresAdminWhatsAppIdentityResolver(pool);

    expect(
      await resolver.whatsAppJidsForPrincipals({
        principalIds: [
          noCapabilityPrincipal,
          allowedPrincipal,
          disabledPrincipal,
          nonWhatsAppPrincipal,
          allowedPrincipal,
        ],
        requiredCapability: "player.registration.read",
      }),
    ).toEqual([allowedJid]);
  });
});
