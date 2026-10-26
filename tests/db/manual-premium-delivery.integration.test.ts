import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntitlementService } from "../../src/modules/entitlements/service.js";
import { ManualPremiumDeliveryService } from "../../src/modules/premium-orders/manual-delivery-service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEntitlementRepository } from "../../src/platform/entitlements/postgres-entitlement-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for manual Premium integration tests");
function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl as string);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("manual Premium grants via published 2XP and LUCK catalog", () => {
  const dbName = `pokemon_manual_premium_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: ManualPremiumDeliveryService;
  let playerId: string;
  const actorPrincipalId = randomUUID();

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "manual-premium-delivery-vitest" });
    service = new ManualPremiumDeliveryService(
      pool,
      new EntitlementService(new PostgresEntitlementRepository(pool)),
    );
  }, 30_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM entitlement_grants");
    await pool.query("DELETE FROM player_entitlements");
    await pool.query("DELETE FROM player_identities");
    await pool.query("DELETE FROM player_profiles");
    await pool.query("DELETE FROM onboarding_states");
    await pool.query("DELETE FROM trainer_progression");
    await pool.query("DELETE FROM players");
    playerId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("lists both products from the real catalog; never lists undefined bundles", async () => {
    const products = await service.catalog();
    const xp = products.find((p) => p.sku === "2XP");
    const luck = products.find((p) => p.sku === "LUCK");
    expect(xp).toMatchObject({
      sku: "2XP", entitlementKey: "XP_2X", grantModel: "TIMED",
      durationSecondsPerUnit: 604800, maxQuantity: 52,
    });
    expect(luck).toMatchObject({
      sku: "LUCK", entitlementKey: "CAPTURE_LUCK_2X", grantModel: "PERMANENT",
      durationSecondsPerUnit: null, maxQuantity: 1,
    });
    expect(products.some((p) => p.sku === "GEN" || p.sku === "TERA")).toBe(false);
  });

  it("grants XP 2x for 14 days once and replays duplicate submission without extra time", async () => {
    const requestId = randomUUID();
    const input = { requestId, playerId, sku: "2XP", quantity: 2,
      reason: "Pagamento conferido externamente pela equipe." };
    expect(await service.deliver(input, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: false,
      entitlement: { entitlementKey: "XP_2X", grantModel: "TIMED" },
    });
    expect(await service.deliver(input, actorPrincipalId)).toMatchObject({
      kind: "APPLIED", replayed: true,
    });
    const entries = await service.history(playerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sku: "2XP", quantity: 2, requestId, actorPrincipalId, durationSeconds: 1209600,
    });
    const rows = await pool.query<{ days: number; grants: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - starts_at)) / 86400 AS days,
         (SELECT count(*)::text FROM entitlement_grants
          WHERE player_id = $1) AS grants
       FROM player_entitlements WHERE player_id = $1 AND entitlement_key = 'XP_2X'`,
      [playerId],
    );
    expect(Number(rows.rows[0]?.days)).toBe(14);
    expect(rows.rows[0]?.grants).toBe("1");
  });

  it("grants permanent LUCK once on retry without expiration, never claims payment", async () => {
    const requestId = randomUUID();
    const input = { requestId, playerId, sku: "LUCK", quantity: 1,
      reason: "Entregue após validação financeira fora do jogo." };
    const first = await service.deliver(input, actorPrincipalId);
    expect(first).toMatchObject({
      kind: "APPLIED", replayed: false,
      entitlement: { entitlementKey: "CAPTURE_LUCK_2X", grantModel: "PERMANENT",
        expiresAt: null },
    });
    const second = await service.deliver(input, actorPrincipalId);
    expect(second).toMatchObject({ kind: "APPLIED", replayed: true });
    const view = await service.history(playerId);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ sku: "LUCK", requestId, actorPrincipalId });
    const rows = await pool.query<{ payments: string; orders: string }>(
      "SELECT (SELECT count(*)::text FROM premium_payment_events) AS payments, " +
        "(SELECT count(*)::text FROM premium_orders) AS orders",
    );
    expect(rows.rows[0]).toEqual({ payments: "0", orders: "0" });
  });

  it("refuses to issue an unpublished gamepass or quantity beyond backend limits", async () => {
    expect(await service.deliver({
      requestId: randomUUID(), playerId, sku: "TERA", quantity: 1,
      reason: "Atendimento manual em vez de executor não existente.",
    }, actorPrincipalId)).toEqual({ kind: "PRODUCT_UNAVAILABLE" });
    expect(await service.deliver({
      requestId: randomUUID(), playerId, sku: "LUCK", quantity: 2,
      reason: "Tentativa de exceder limite permitido pela loja.",
    }, actorPrincipalId)).toEqual({ kind: "QUANTITY_LIMIT" });
    expect((await service.history(playerId))).toHaveLength(0);
  });
});
