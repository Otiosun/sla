import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, MessageHandlerResult } from "../../src/modules/messaging/contracts.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresWhatsAppReplyResultContextResolver } from "../../src/platform/messaging/postgres-whatsapp-reply-result-context.js";

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

function incoming(input: {
  readonly externalMessageId: string;
  readonly chatRef: string;
  readonly senderRef: string;
  readonly mentions?: readonly string[];
}): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: input.externalMessageId,
    senderRef: input.senderRef,
    chatRef: input.chatRef,
    occurredAt: "2026-09-30T00:00:00.000Z",
    text: "/batalha",
    ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }),
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

describe.sequential("PostgresWhatsAppReplyResultContextResolver", () => {
  const dbName = `pokemon_whatsapp_reply_context_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let messaging: PostgresMessagingRepository;
  let resolver: PostgresWhatsAppReplyResultContextResolver;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "whatsapp-reply-context-vitest" });
    messaging = new PostgresMessagingRepository(pool);
    resolver = new PostgresWhatsAppReplyResultContextResolver(pool);
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

  it("resolves a native reply to a bot outbound message back to the exact encounter result", async () => {
    const chatRef = "120363900001@g.us";
    const narratorRef = "5511999999999@s.whatsapp.net";
    const playerRef = "5511888888888@s.whatsapp.net";
    const encounterId = randomUUID();

    const claim = await messaging.claimIncoming(
      incoming({
        externalMessageId: "3EB0SPAWNCOMMAND",
        chatRef,
        senderRef: narratorRef,
        mentions: [playerRef],
      }),
      30_000,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok || claim.value.status !== "CLAIMED") throw new Error("Expected claimed inbox");

    const result: MessageHandlerResult = {
      resultRefType: "ENCOUNTER",
      resultRefId: encounterId,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: chatRef,
          messageType: "TEXT",
          payload: {
            text: "◇ *ENCONTRO SELVAGEM*",
            mentions: [playerRef],
          },
          idempotencyKey: `reply-context:${encounterId}`,
        },
      ],
    };
    const completed = await messaging.completeIncoming(claim.value.inboxMessageId, result);
    expect(completed.ok).toBe(true);

    const outbox = await pool.query<{ id: string }>(
      "SELECT id::text FROM outbox_messages WHERE causation_id=$1 AND channel='whatsapp'",
      [claim.value.inboxMessageId],
    );
    const outboxId = outbox.rows[0]?.id;
    if (outboxId === undefined) throw new Error("Expected outbound message");
    const providerMessageId = outboxId.replaceAll("-", "").toUpperCase();

    await expect(
      resolver.resolve({
        provider: "baileys",
        chatRef,
        externalMessageId: providerMessageId,
      }),
    ).resolves.toEqual({
      resultRefType: "ENCOUNTER",
      resultRefId: encounterId,
      mentions: [playerRef],
    });

    await expect(
      resolver.resolve({
        provider: "baileys",
        chatRef: "120363900999@g.us",
        externalMessageId: providerMessageId,
      }),
    ).resolves.toBeNull();
  });

  it("resolves a direct reply target from a processed inbound message without recency guessing", async () => {
    const chatRef = "120363900002@g.us";
    const playerRef = "5511777777777@s.whatsapp.net";
    const battleId = randomUUID();

    const claim = await messaging.claimIncoming(
      incoming({
        externalMessageId: "3EB0DIRECTBATTLE",
        chatRef,
        senderRef: playerRef,
        mentions: [playerRef],
      }),
      30_000,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok || claim.value.status !== "CLAIMED") throw new Error("Expected claimed inbox");

    const completed = await messaging.completeIncoming(claim.value.inboxMessageId, {
      resultRefType: "BATTLE",
      resultRefId: battleId,
      outgoing: [],
    });
    expect(completed.ok).toBe(true);

    await expect(
      resolver.resolve({
        provider: "baileys",
        chatRef,
        externalMessageId: "3EB0DIRECTBATTLE",
      }),
    ).resolves.toEqual({
      resultRefType: "BATTLE",
      resultRefId: battleId,
      mentions: [playerRef],
    });
  });
});
