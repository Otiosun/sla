import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommunityService } from "../../src/modules/community/service.js";
import { PostgresCommunityRepository } from "../../src/platform/community/postgres-community-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("PostgresCommunityRepository", () => {
  const dbName = `pokemon_community_repo_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: CommunityService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "community-repository-vitest" });
    service = new CommunityService(new PostgresCommunityRepository(pool));
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

  it("persists JID authority, capabilities, optimistic updates and retirement", async () => {
    const created = await service.registerGroup({
      provider: "baileys",
      chatRef: "120363000000900001@g.us",
      role: "RECEPTION",
      displayName: "Recepção inicial",
    });
    if (!created.ok) throw created.error;

    const configured = await service.replaceCapabilities({
      groupId: created.value.id,
      expectedRevision: created.value.revision,
      capabilities: ["onboarding", "player.basic"],
    });
    if (!configured.ok) throw configured.error;

    const renamed = await service.renameGroup({
      groupId: created.value.id,
      expectedRevision: configured.value.revision,
      displayName: "Recepção renomeada",
    });
    if (!renamed.ok) throw renamed.error;

    expect(
      await service.resolveChat({
        provider: "baileys",
        chatRef: "120363000000900001@g.us",
      }),
    ).toEqual({
      known: true,
      groupId: created.value.id,
      role: "RECEPTION",
      capabilities: ["onboarding", "player.basic"],
    });
    expect(
      await service.resolveChat({ provider: "baileys", chatRef: "Recepção renomeada" }),
    ).toEqual({ known: false, groupId: null, role: null, capabilities: [] });

    expect(
      await service.renameGroup({
        groupId: created.value.id,
        expectedRevision: configured.value.revision,
        displayName: "stale update",
      }),
    ).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });

    const retired = await service.retireGroup({
      groupId: created.value.id,
      expectedRevision: renamed.value.revision,
    });
    if (!retired.ok) throw retired.error;
    expect(
      await service.resolveChat({
        provider: "baileys",
        chatRef: "120363000000900001@g.us",
      }),
    ).toEqual({ known: false, groupId: null, role: null, capabilities: [] });
  });

  it("persists reception staff assignments without granting group capabilities", async () => {
    const principalId = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [principalId, "baileys:5511999999999@s.whatsapp.net"],
    );

    const created = await service.registerGroup({
      provider: "baileys",
      chatRef: "120363000000900002@g.us",
      role: "RECEPTION",
      displayName: "Recepção staff",
    });
    if (!created.ok) throw created.error;

    const assigned = await service.assignReceptionStaff({
      groupId: created.value.id,
      adminPrincipalId: principalId,
    });
    expect(assigned).toEqual({ ok: true, value: undefined });
    expect(await service.listReceptionStaff(created.value.id)).toEqual([principalId]);

    expect(
      await service.resolveChat({
        provider: "baileys",
        chatRef: "120363000000900002@g.us",
      }),
    ).toEqual({
      known: true,
      groupId: created.value.id,
      role: "RECEPTION",
      capabilities: [],
    });
  });
});
