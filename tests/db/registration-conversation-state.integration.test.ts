import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RegistrationService } from "../../src/modules/registration/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresRegistrationRepository } from "../../src/platform/registration/postgres-registration-repository.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_ID = "22222222-2222-4222-8222-222222222222";
const RECEPTION_JID = "120363000000900123@g.us";

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("registration conversation persistence", () => {
  const dbName = `pokemon_registration_conversation_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: RegistrationService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "registration-conversation-vitest" });
    service = new RegistrationService(new PostgresRegistrationRepository(pool));
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

  it("creates the durable registration_conversations table", async () => {
    const table = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.registration_conversations')::text AS name",
    );

    expect(table.rows[0]?.name).toBe("registration_conversations");
  });

  it("persists draft and guided checkpoint atomically and replays the same inbox once", async () => {
    const playerId = createPlayerId();
    const inboxMessageId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);

    const input = {
      playerId,
      chatRef: RECEPTION_JID,
      state: "GUIDED_FIELD" as const,
      editingMode: "GUIDED" as const,
      currentField: "age" as const,
      editField: null,
      activePromptOutboxIdempotencyKey: "registration:prompt:age:1",
      expectedConversationRevision: null,
      expectedDraftRevision: null,
      inboxMessageId,
      draft: {
        trainerName: "Killian",
        regionId: REGION_ID,
        schemaVersion: 1,
      },
    };

    const first = await service.saveConversationCheckpoint(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        conversation: {
          playerId,
          chatRef: RECEPTION_JID,
          state: "GUIDED_FIELD",
          editingMode: "GUIDED",
          currentField: "age",
          revision: 0,
        },
        draft: {
          revision: 0,
          snapshot: { trainerName: "Killian" },
        },
      },
    });

    const replay = await service.saveConversationCheckpoint(input);
    expect(replay).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        conversation: { revision: 0 },
        draft: { revision: 0 },
      },
    });

    const restored = await service.getConversation(playerId);
    expect(restored).toMatchObject({
      ok: true,
      value: {
        state: "GUIDED_FIELD",
        currentField: "age",
        activePromptOutboxIdempotencyKey: "registration:prompt:age:1",
        draftRevision: 0,
      },
    });
  });

  it("deletes only mutable draft/conversation and preserves immutable review history", async () => {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);

    const draft = {
      trainerName: "Liora Vale",
      age: 17,
      genderPronouns: "ela/dela",
      appearance: "Cabelos negros e casaco de viagem.",
      personality: "Curiosa e competitiva.",
      backstory: "Saiu de casa para pesquisar Pokémon raros.",
      starterFormId: STARTER_ID,
      regionId: REGION_ID,
      schemaVersion: 1,
    };

    const checkpoint = await service.saveConversationCheckpoint({
      playerId,
      chatRef: RECEPTION_JID,
      state: "REVIEW",
      editingMode: "GUIDED",
      currentField: null,
      editField: null,
      activePromptOutboxIdempotencyKey: "registration:prompt:review:1",
      expectedConversationRevision: null,
      expectedDraftRevision: null,
      inboxMessageId: randomUUID(),
      draft,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) return;

    const submitted = await service.saveAndSubmit({
      playerId,
      draft,
      expectedDraftRevision: checkpoint.value.draft?.revision ?? null,
      idempotencyKey: `registration-reset-safety:${playerId}`,
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const mutableDraft = await service.getDraft(playerId);
    expect(mutableDraft.ok).toBe(true);
    if (!mutableDraft.ok) return;

    const reset = await service.resetMutableRegistration({
      playerId,
      expectedConversationRevision: checkpoint.value.conversation.revision,
      expectedDraftRevision: mutableDraft.value.revision,
    });
    expect(reset).toEqual({ ok: true, value: { reset: true } });

    await expect(service.getConversation(playerId)).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await expect(service.getDraft(playerId)).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await expect(service.getReview(submitted.value.id)).resolves.toMatchObject({
      ok: true,
      value: {
        id: submitted.value.id,
        playerId,
        status: "SUBMITTED",
      },
    });
  });
});
