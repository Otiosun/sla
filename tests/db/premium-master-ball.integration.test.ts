import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresAdminRewardCatalogRepository } from "../../src/platform/admin/postgres-admin-reward-catalog-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { ok } from "../../src/shared-kernel/result.js";

const dbUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !value ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error("MASTER integration is restricted to explicitly authorized local disposable PostgreSQL");
  }
  return value;
})();
function dbConnection(name: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("MASTER commercial inventory grant with disposable PostgreSQL", () => {
  const dbName = `premium_master_${process.pid}_${Date.now()}`;
  const ownerId = randomUUID();
  const playerId = randomUUID();
  const itemId = randomUUID();
  const path = "/v1/hub/admin/premium/delivery/packs/master";
  let adminPool: Pool;
  let pool: Pool;
  let economy: EconomyService;
  let handler: PlayerPortalHttpHandler;
  let releaseId: string;

  const deliver = (requestId: string, quantity = 2, extra?: Record<string, unknown>) =>
    handler.handle(new Request(`https://staging.invalid${path}`, {
      method: "POST",
      headers: {
        cookie: "__Host-pokemon_hub_session=synthetic-test-only",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId, playerId, sku: "MASTER", quantity,
        reason: "Concessão humana testada em banco totalmente descartável.", ...extra,
      }),
    }));
  const catalog = () => handler.handle(new Request(`https://staging.invalid${path}`, {
    headers: { cookie: "__Host-pokemon_hub_session=synthetic-test-only" },
  }));

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbConnection("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbConnection(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "master-pack-disposable-proof" });

    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [playerId]);
    await pool.query("INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1,$2,'ACTIVE')",
      [ownerId, "synthetic:premium-master"]);
    const roleId = randomUUID();
    await pool.query("INSERT INTO admin_roles(id,slug,name) VALUES ($1,'PREMIUM_MASTER_PROOF','Premium Master Test')", [roleId]);
    await pool.query("INSERT INTO capabilities(id,key,risk_tier) VALUES ($1,'inventory.adjust',2) ON CONFLICT (key) DO NOTHING", [randomUUID()]);
    await pool.query(`INSERT INTO admin_role_capabilities(role_id,capability_id)
      SELECT $1,id FROM capabilities WHERE key='inventory.adjust'`, [roleId]);
    await pool.query("INSERT INTO admin_principal_roles(principal_id,role_id) VALUES ($1,$2)", [ownerId,roleId]);
    await pool.query(`INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id)
      VALUES ($1,$2,'GLOBAL',NULL)`, [randomUUID(),ownerId]);

    const rulesetId = randomUUID();
    releaseId = randomUUID();
    await pool.query(`INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
      VALUES ($1,'master-pack-disposable-test',1,1,'{}'::jsonb,'DRAFT')`, [rulesetId]);
    await pool.query(`UPDATE rulesets SET status='VALIDATED',validated_at=now(),
      validation_report='{"valid":true,"issues":[]}'::jsonb,config_fingerprint=$2 WHERE id=$1`,
      [rulesetId, "a".repeat(64)]);
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [rulesetId]);
    await pool.query(`INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id)
      VALUES ($1,1,'Disposable Master proof','DRAFT',$2)`, [releaseId,rulesetId]);
    await pool.query("INSERT INTO items(id,slug) VALUES ($1,'master-ball')", [itemId]);
    // Fixture's item kind is from an established valid test schema; the SKU resolves by exact slug.
    await pool.query(`INSERT INTO item_revisions(
      id,content_release_id,item_id,display_name,item_kind,effect_key,effect_config)
      VALUES ($1,$2,$3,'Master Ball','MEDICINE','heal-hp','{"amount":20}'::jsonb)`,
      [randomUUID(),releaseId,itemId]);
    await pool.query(`UPDATE content_releases SET status='VALIDATED',validated_at=now(),
      validation_report='{"valid":true,"issues":[]}'::jsonb,content_fingerprint=$2 WHERE id=$1`,
      [releaseId,"b".repeat(64)]);
    await pool.query("UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1", [releaseId]);
    await pool.query(`INSERT INTO content_release_pointers(pointer_key,content_release_id)
      VALUES ('ACTIVE',$1)`, [releaseId]);

    economy = new EconomyService(new PostgresEconomyRepository(pool));
    const domain = new AdminDomainOperationService(
      economy,
      {} as ConstructorParameters<typeof AdminDomainOperationService>[1],
      new PostgresAdminOperationCompletion(pool),
    );
    const adminOperations = new AdminService(
      registerPhase12CDomainAdminOperations(new AdminOperationRegistry(), domain),
      new PostgresAdminRepository(pool),
    );
    const published = new PostgresAdminRewardCatalogRepository(pool);
    handler = new PlayerPortalHttpHandler({
      sessions: { verify: () => ok({ provider: "baileys", externalId: "synthetic@s.whatsapp.net" }) },
      admin: { resolvePrincipal: async () => ({ principalId: ownerId }), capabilitiesFor: async () => ["central.view"] },
      adminTeam: { isOwner: async (principal: string) => principal === ownerId },
      adminRewardCatalog: { get: async () => published.getActiveRewardCatalog() },
      adminMutations: adminOperations,
      premiumDelivery: {},
    } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 60_000);

  it("grants once using a published real catalog record and existing economy ledger, not payments", async () => {
    expect((await catalog()).status).toBe(200);
    expect(await (await catalog()).json()).toMatchObject({
      available: true, sku: "MASTER", item: { itemId },
    });
    const requestId = randomUUID();
    expect((await deliver(requestId, 2, { paid: true })).status).toBe(400);
    expect((await deliver(requestId, 2)).status).toBe(201);
    const replay = await deliver(requestId, 2);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      applied: true, replayed: true, sku: "MASTER", itemId, playerId, quantity: 2,
    });
    expect((await deliver(requestId, 3)).status).toBe(409);
    const balance = await economy.getInventoryBalance(playerId as Parameters<EconomyService["getInventoryBalance"]>[0], itemId);
    if (!balance.ok) throw new Error(balance.error.message);
    expect(balance.value).toBe(2n);

    const counts = await pool.query<{ operations: string; orders: string; payments: string }>(`
      SELECT (SELECT count(*)::text FROM admin_operations WHERE operation_type='inventory.adjust') AS operations,
        (SELECT count(*)::text FROM premium_orders) AS orders,
        (SELECT count(*)::text FROM premium_payment_events) AS payments`);
    expect(counts.rows[0]).toEqual({operations:"1",orders:"0",payments:"0"});
  });
  it("refuses nonpublished catalog records without adjusting inventory", async () => {
    await pool.query("DELETE FROM content_release_pointers WHERE pointer_key='ACTIVE'");
    const read = await catalog();
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({available:false,item:null});
    expect((await deliver(randomUUID())).status).toBe(409);
    const balance = await economy.getInventoryBalance(playerId as Parameters<EconomyService["getInventoryBalance"]>[0], itemId);
    if (!balance.ok) throw new Error(balance.error.message);
    expect(balance.value).toBe(2n);
  });
});
