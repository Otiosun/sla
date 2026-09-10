import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresHubLoginTicketStore } from "../../src/platform/player-portal/postgres-hub-login-ticket-store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("PostgresHubLoginTicketStore", () => {
  it("supplies the required ticket row id when issuing", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({
      command: "INSERT",
      rowCount: 1,
      oid: 0,
      rows: [],
      fields: [],
    }));
    const store = new PostgresHubLoginTicketStore({ query } as unknown as Pick<Pool, "query">);
    const expiresAt = new Date("2026-09-10T20:05:00.000Z");

    await store.issue({
      ticketHash: "a".repeat(64),
      identity: {
        provider: "baileys",
        externalId: "5511999999999@s.whatsapp.net",
      },
      expiresAt,
    });

    expect(query).toHaveBeenCalledOnce();
    const call = query.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    const sql = call[0];
    const params = call[1];
    expect(String(sql)).toContain("id,");
    expect(Array.isArray(params)).toBe(true);
    if (!Array.isArray(params)) return;

    expect(params).toHaveLength(5);
    expect(params[0]).toEqual(expect.stringMatching(UUID_PATTERN));
    expect(params.slice(1)).toEqual([
      "a".repeat(64),
      "baileys",
      "5511999999999@s.whatsapp.net",
      expiresAt,
    ]);
  });
});
