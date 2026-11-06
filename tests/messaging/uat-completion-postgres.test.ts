import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_ROLE_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";
import { createUatBootstrapRoutes } from "../../src/modules/admin/uat-bootstrap.js";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";

// Same disposable-cluster opt-in as the integrated regression. Never connects
// to an installed runtime role or copies tables from a live schema.
const maintenance = process.env.POSTGRES_INTEGRATION_TEST_URL;
const enabled = maintenance !== undefined && process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1";
describe.skipIf(!enabled)("UAT completion with the actual PostgreSQL schema", () => {
  it("persists OWNER success and non-admin error, sends both, and preserves replay semantics", async () => {
    const coordinates = new URL(maintenance!);
    if (
      coordinates.pathname !== "/postgres" ||
      !["127.0.0.1", "localhost"].includes(coordinates.hostname)
    )
      throw new Error("Owned loopback PostgreSQL maintenance database required");
    const admin = new Pool({ connectionString: coordinates.toString(), max: 1 });
    const database = "uat_completion_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE DATABASE "${database}"`);
    coordinates.pathname = "/" + database;
    const pool = new Pool({ connectionString: coordinates.toString(), max: 4 });
    const client = pool;
    try {
      await runMigrations(pool, { appliedBy: "disposable-uat-completion-proof" });
      const repository = new PostgresMessagingRepository(pool);
      const forbidden = vi.fn(async (): Promise<never> => {
        throw new Error("Help must not mutate gameplay");
      });
      const gate = new RuntimeCommandPolicyGate({
        community: {
          resolveChat: async () => ({
            known: true,
            groupId: "game",
            role: "GAME",
            // UAT admin commands still require a configured GAME group with world.
            capabilities: ["world"],
          }),
        },
        admins: {
          capabilitiesFor: async ({ externalId }) =>
            externalId === "owner" ? (ADMIN_ROLE_CAPABILITIES.OWNER_SECURITY_ADMIN ?? []) : [],
        },
        players: { resolvePlayer: forbidden },
        access: { load: forbidden },
      });
      const routes = createUatBootstrapRoutes({
        admins: {
          resolvePrincipal: async ({ externalId }) =>
            externalId === "owner" ? { principalId: randomUUID() } : null,
        },
        service: { bootstrap: forbidden, prepare: forbidden, status: forbidden },
      });
      const router = new MessageRouter(routes, gate);
      const service = new MessagingService(repository, router);
      const inbound = (sender: string): IncomingMessage => ({
        provider: "baileys",
        externalMessageId: randomUUID(),
        senderRef: sender,
        chatRef: "game",
        occurredAt: new Date().toISOString(),
        text: "/teste",
        mediaRefs: [],
        replyToExternalMessageId: null,
      });
      const first = inbound("owner");
      expect(await service.receive(first)).toMatchObject({
        ok: true,
        value: { status: "PROCESSED", resultRefType: "UAT" },
      });
      expect(await service.receive(first)).toMatchObject({
        ok: true,
        value: { status: "REPLAYED" },
      });
      expect(await service.receive(inbound("owner"))).toMatchObject({
        ok: true,
        value: { status: "PROCESSED", resultRefType: "UAT" },
      });
      expect(await service.receive(inbound("friend"))).toMatchObject({
        ok: true,
        value: { status: "PROCESSED", resultRefType: "MESSAGING_ERROR" },
      });
      expect((await client.query("SELECT status FROM outbox_messages")).rows).toEqual([
        { status: "PENDING" },
        { status: "PENDING" },
        { status: "PENDING" },
      ]);
      const send = vi.fn(async () => ({ providerExternalMessageId: randomUUID() }));
      const worker = new OutboxWorker(repository, [{ channel: "whatsapp", send }], {
        batchSize: 10,
        staleAfterMs: 30000,
        maxAttempts: 3,
        baseBackoffMs: 100,
        maxBackoffMs: 1000,
      });
      expect(await worker.runOnce()).toEqual({ claimed: 3, sent: 3, failed: 0 });
      expect(send).toHaveBeenCalledTimes(3);
      expect(
        (await client.query("SELECT count(*)::int n FROM outbox_messages WHERE status='SENT'"))
          .rows[0].n,
      ).toBe(3);
      expect(forbidden).not.toHaveBeenCalled();

      const broken = new MessagingService(repository, {
        classify: router.classify.bind(router),
        dispatch: async () => ({
          ok: true,
          value: { resultRefType: "UAT", resultRefId: "uat-help", outgoing: [] },
        }),
      });
      const invalid = inbound("owner");
      expect(await broken.receive(invalid)).toMatchObject({ ok: false });
      expect(
        (
          await client.query(
            "SELECT status,last_error_code FROM inbox_messages WHERE external_message_id=$1",
            [invalid.externalMessageId],
          )
        ).rows[0],
      ).toMatchObject({ status: "FAILED", last_error_code: "COMPLETE_INCOMING_SQLSTATE_22P02" });
      expect(
        (await client.query("SELECT count(*)::int n FROM inbox_messages WHERE status='PROCESSING'"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
    }
  }, 30000);
});
