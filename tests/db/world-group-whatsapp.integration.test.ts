import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe.sequential("World group setup through the operational WhatsApp router", () => {
  const dbName = `pokemon_world_group_${process.pid}_${Date.now()}`;
  const principalId = randomUUID();
  const sender = "5511999999999@s.whatsapp.net";
  let adminPool: Pool;
  let pool: Pool;

  function context(
    text = "/grupo jogo Arrozais UAT",
    chatRef = "120363900001@g.us",
    senderRef = sender,
  ): MessageHandlerContext {
    const id = randomUUID();
    return {
      inboxMessageId: id,
      correlationId: id,
      causationId: id,
      idempotencyKey: `inbox:baileys:${id}`,
      message: {
        provider: "baileys",
        externalMessageId: id,
        senderRef,
        chatRef,
        text,
        occurredAt: new Date().toISOString(),
        mediaRefs: [],
        replyToExternalMessageId: null,
      },
    };
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.pathname = "/postgres";
    adminPool = new Pool({ connectionString: url.toString(), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 5 });
    await runMigrations(pool);
    const roleId = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1,$2,'ACTIVE')",
      [principalId, `whatsapp:${sender}`],
    );
    await pool.query(
      "INSERT INTO admin_roles(id,slug,name) VALUES ($1,'world-setup-test','World setup test')",
      [roleId],
    );
    await pool.query(
      "INSERT INTO capabilities(id,key,risk_tier) VALUES ($1,'community.group.manage',3) ON CONFLICT (key) DO NOTHING",
      [randomUUID()],
    );
    await pool.query(
      "INSERT INTO admin_role_capabilities(role_id,capability_id) SELECT $1,id FROM capabilities WHERE key='community.group.manage'",
      [roleId],
    );
    await pool.query("INSERT INTO admin_principal_roles(principal_id,role_id) VALUES ($1,$2)", [
      principalId,
      roleId,
    ]);
    await pool.query(
      "INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id) VALUES ($1,$2,'GLOBAL',NULL)",
      [randomUUID(), principalId],
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });

  it("admits setup in an unknown group and persists one audited GAME group with world access", async () => {
    const composition = createOperationalMessagingComposition(pool);
    const input = context();
    expect(composition.admitCommand(input.message)).toBe(true);
    expect(composition.router.classify(input.message).sensitiveActionKey).toBe("command:grupo");
    const result = await composition.router.dispatch(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value?.outgoing[0]?.destinationRef).toBe(input.message.chatRef);
    const groups = await pool.query(
      "SELECT id,role,display_name FROM community_groups WHERE chat_ref=$1",
      [input.message.chatRef],
    );
    expect(groups.rows).toEqual([
      { id: expect.any(String), role: "GAME", display_name: "Arrozais UAT" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT capability_key FROM community_group_capabilities WHERE group_id=$1 AND active ORDER BY capability_key",
          [groups.rows[0].id],
        )
      ).rows,
    ).toEqual([{ capability_key: "player.basic" }, { capability_key: "world" }]);
    expect(
      (
        await pool.query(
          "SELECT status FROM admin_operations WHERE operation_type='community.group.enable_world'",
        )
      ).rows,
    ).toEqual([{ status: "APPLIED" }]);
    expect(
      (
        await pool.query(
          "SELECT actor_id FROM audit_events WHERE action='community.group.enable_world'",
        )
      ).rows,
    ).toEqual([{ actor_id: principalId }]);
    const replay = await createOperationalMessagingComposition(pool).router.dispatch(input);
    expect(replay).toEqual(result);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='community.group.enable_world'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("denies an ordinary sender even when the target is an unknown group", async () => {
    const result = await createOperationalMessagingComposition(pool).router.dispatch(
      context(undefined, "120363900002@g.us", "5511888888888@s.whatsapp.net"),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM community_groups WHERE chat_ref='120363900002@g.us'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("denies direct messages and malformed setup without changing groups", async () => {
    for (const input of [
      context(undefined, sender),
      context("/grupo jogo"),
      context("/grupo admin Nome"),
    ]) {
      expect(
        await createOperationalMessagingComposition(pool).router.dispatch(input),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
  });

  it("preserves GAME settings and serializes simultaneous setup", async () => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO community_groups(id,provider,chat_ref,role,display_name) VALUES ($1,'baileys','120363900004@g.us','GAME','Existing name')",
      [id],
    );
    await pool.query(
      "INSERT INTO community_group_capabilities(group_id,capability_key) VALUES ($1,'pve')",
      [id],
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        createOperationalMessagingComposition(pool).router.dispatch(
          context(undefined, "120363900004@g.us"),
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      (
        await pool.query("SELECT display_name,revision::int FROM community_groups WHERE id=$1", [
          id,
        ])
      ).rows,
    ).toEqual([{ display_name: "Existing name", revision: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT capability_key FROM community_group_capabilities WHERE group_id=$1 AND active ORDER BY capability_key",
          [id],
        )
      ).rows,
    ).toEqual([
      { capability_key: "player.basic" },
      { capability_key: "pve" },
      { capability_key: "world" },
    ]);
  });

  it("requires global RPG scope even for an account with the capability", async () => {
    await pool.query(
      "UPDATE admin_principal_scopes SET status='REVOKED',revoked_at=now() WHERE principal_id=$1",
      [principalId],
    );
    try {
      expect(
        await createOperationalMessagingComposition(pool).router.dispatch(
          context(undefined, "120363900005@g.us"),
        ),
      ).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community_groups WHERE chat_ref='120363900005@g.us'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        "UPDATE admin_principal_scopes SET status='ACTIVE',revoked_at=NULL WHERE principal_id=$1",
        [principalId],
      );
    }
  });

  it("rolls group and capabilities back when audit persistence fails", async () => {
    await pool.query(
      "CREATE FUNCTION reject_world_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_world_group_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_world_group_audit()",
    );
    const input = context(undefined, "120363900006@g.us");
    try {
      await expect(
        createOperationalMessagingComposition(pool).router.dispatch(input),
      ).rejects.toThrow("injected audit failure");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM community_groups WHERE chat_ref='120363900006@g.us'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER reject_world_group_audit ON audit_events");
      await pool.query("DROP FUNCTION reject_world_group_audit()");
    }
    expect(await createOperationalMessagingComposition(pool).router.dispatch(input)).toMatchObject({
      ok: true,
    });
  });

  it("refuses to repurpose Reception and preserves its capabilities", async () => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO community_groups(id,provider,chat_ref,role,display_name) VALUES ($1,'baileys','120363900003@g.us','RECEPTION','Recepcao')",
      [id],
    );
    await pool.query(
      "INSERT INTO community_group_capabilities(group_id,capability_key) VALUES ($1,'onboarding')",
      [id],
    );
    expect(
      await createOperationalMessagingComposition(pool).router.dispatch(
        context(undefined, "120363900003@g.us"),
      ),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(
      (await pool.query("SELECT role FROM community_groups WHERE id=$1", [id])).rows[0].role,
    ).toBe("RECEPTION");
    expect(
      (
        await pool.query(
          "SELECT capability_key FROM community_group_capabilities WHERE group_id=$1 AND active",
          [id],
        )
      ).rows,
    ).toEqual([{ capability_key: "onboarding" }]);
  });
});
