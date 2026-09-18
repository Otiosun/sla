import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { HubLoginTicketRecord } from "../../src/modules/player-portal/login-ticket-service.js";
import { PostgresHubLoginTicketStore } from "../../src/platform/player-portal/postgres-hub-login-ticket-store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("PostgresHubLoginTicketStore", () => {
  it("supplies the required UUID primary key when issuing a Hub login ticket", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const store = new PostgresHubLoginTicketStore({
      query,
    } as unknown as Pick<Pool, "query">);
    const record: HubLoginTicketRecord = {
      ticketHash: "a".repeat(64),
      identity: {
        provider: "baileys",
        externalId: "5511999999999@s.whatsapp.net",
      },
      expiresAt: new Date("2026-09-10T20:05:00.000Z"),
    };

    await store.issue(record);

    expect(query).toHaveBeenCalledOnce();
    const call = query.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    const [sql, values] = call;
    expect(sql).toContain("INSERT INTO hub_login_tickets");
    expect(sql).toContain("id,");
    expect(values).toBeDefined();
    if (values === undefined) return;

    expect(values).toHaveLength(5);
    expect(values[0]).toEqual(expect.stringMatching(UUID_PATTERN));
    expect(values.slice(1)).toEqual([
      record.ticketHash,
      record.identity.provider,
      record.identity.externalId,
      record.expiresAt,
    ]);
  });
});
