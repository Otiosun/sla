import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresReceptionPresenceRepository } from "../../src/platform/community/postgres-reception-presence-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { parsePlayerId } from "../../src/shared-kernel/ids.js";

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

describe.sequential("PostgresReceptionPresenceRepository", () => {
  const dbName = `pokemon_reception_presence_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "reception-presence-vitest" });
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

  it("commits membership and outbox together; deduplicates add across repository instances and preserves rejoin generations", async () => {
    const groupId = randomUUID();
    const rawId = randomUUID();
    const parsed = parsePlayerId(rawId);
    if (!parsed.ok) throw parsed.error;
    const playerId = parsed.value;
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO community_groups(id, provider, chat_ref, role, display_name) VALUES ($1, 'baileys', $2, 'RECEPTION', 'Reception')",
      [groupId, `${groupId}@g.us`],
    );
    const input = { groupId, playerId, chatRef: `${groupId}@g.us`, action: "add" as const };
    const welcome = async () => ({
      messageType: "IMAGE" as const,
      payload: {
        imageUrl: "https://example.com/rotom.jpg",
        caption: "Rotom /registrar",
        mentions: ["123@lid"],
      },
    });
    const repository = new PostgresReceptionPresenceRepository(pool);
    await expect(
      repository.recordMembership(input, async () => {
        throw new Error("injected welcome failure");
      }),
    ).rejects.toThrow("injected welcome failure");
    expect(
      (await pool.query("SELECT * FROM community_member_presence WHERE group_id=$1", [groupId]))
        .rows,
    ).toHaveLength(0);
    await Promise.all(Array.from({ length: 6 }, () => repository.recordMembership(input, welcome)));
    await new PostgresReceptionPresenceRepository(pool).recordMembership(input, welcome);
    const messages = () =>
      pool.query("SELECT * FROM outbox_messages WHERE destination_ref=$1 ORDER BY created_at, id", [
        input.chatRef,
      ]);
    expect((await messages()).rows).toHaveLength(1);
    await repository.recordMembership({ ...input, action: "remove" }, async () => {
      throw new Error("remove must not prepare welcome");
    });
    await repository.recordMembership({ ...input, action: "remove" }, welcome);
    await repository.recordMembership(input, welcome);
    expect((await messages()).rows).toHaveLength(2);
    expect(
      (
        await pool.query(
          "SELECT presence_generation::text FROM community_member_presence WHERE group_id=$1",
          [groupId],
        )
      ).rows[0],
    ).toEqual({ presence_generation: "2" });
    // Inject an outbox write failure: the presence must roll back with it.
    await repository.recordMembership({ ...input, action: "remove" }, welcome);
    await pool.query(
      "CREATE FUNCTION reject_reception_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_reception_outbox BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION reject_reception_outbox()",
    );
    try {
      await expect(repository.recordMembership(input, welcome)).rejects.toThrow(
        "injected outbox failure",
      );
      expect(
        (
          await pool.query(
            "SELECT presence_generation::text FROM community_member_presence WHERE group_id=$1",
            [groupId],
          )
        ).rows[0],
      ).toEqual({ presence_generation: "2" });
    } finally {
      await pool.query("DROP TRIGGER reject_reception_outbox ON outbox_messages");
      await pool.query("DROP FUNCTION reject_reception_outbox()");
    }
    await repository.recordMembership(input, welcome);
    expect((await messages()).rows).toHaveLength(3);
  });

  it("atomically claims the first welcome exactly once for one group/player presence generation", async () => {
    const groupId = randomUUID();
    const rawPlayerId = randomUUID();
    const playerId = parsePlayerId(rawPlayerId);
    if (!playerId.ok) throw playerId.error;

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [rawPlayerId]);
    await pool.query(
      `INSERT INTO community_groups(id, provider, chat_ref, role, display_name)
       VALUES ($1, 'baileys', '120363000000000001@g.us', 'RECEPTION', 'Recepção')`,
      [groupId],
    );

    const repository = new PostgresReceptionPresenceRepository(pool);
    expect(await repository.needsFirstWelcome({ groupId, playerId: playerId.value })).toBe(true);

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.claimFirstWelcome({ groupId, playerId: playerId.value }),
      ),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await repository.claimFirstWelcome({ groupId, playerId: playerId.value })).toBe(false);
    expect(await repository.needsFirstWelcome({ groupId, playerId: playerId.value })).toBe(false);

    const stored = await pool.query<{
      presence_generation: string;
      first_seen_at: Date;
      last_seen_at: Date;
      last_welcome_at: Date | null;
    }>(
      `SELECT presence_generation::text, first_seen_at, last_seen_at, last_welcome_at
       FROM community_member_presence
       WHERE group_id = $1 AND player_id = $2`,
      [groupId, rawPlayerId],
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ presence_generation: "0" });
    expect(stored.rows[0]?.first_seen_at).toBeInstanceOf(Date);
    expect(stored.rows[0]?.last_seen_at).toBeInstanceOf(Date);
    expect(stored.rows[0]?.last_welcome_at).toBeInstanceOf(Date);
  });
});
