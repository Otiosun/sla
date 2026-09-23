import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import {
  type HubLoginTicketRecord,
  HubLoginTicketService,
  type HubLoginTicketStore,
} from "../../src/modules/player-portal/login-ticket-service.js";

const identity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999999@s.whatsapp.net",
};

class MemoryTicketStore implements HubLoginTicketStore {
  public issued: HubLoginTicketRecord | null = null;
  public consumeCalls = 0;

  public async issue(record: HubLoginTicketRecord): Promise<void> {
    this.issued = record;
  }

  public async consume(input: {
    readonly ticketHash: string;
    readonly now: Date;
  }): Promise<ExternalIdentity | null> {
    this.consumeCalls += 1;
    const record = this.issued;
    if (
      record === null ||
      record.ticketHash !== input.ticketHash ||
      record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return null;
    }
    this.issued = null;
    return record.identity;
  }
}

const rawTicket = "A".repeat(43);
const issuedAt = new Date("2026-09-18T12:00:00.000Z");

function service(store: HubLoginTicketStore, now = issuedAt): HubLoginTicketService {
  return new HubLoginTicketService(store, {
    now: () => now,
    generateToken: () => rawTicket,
  });
}

describe("HubLoginTicketService", () => {
  it("stores only the SHA-256 hash and expires after five minutes", async () => {
    const store = new MemoryTicketStore();
    const result = await service(store).issue(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket).toBe(rawTicket);
    expect(result.value.expiresAt.toISOString()).toBe("2026-09-18T12:05:00.000Z");
    expect(store.issued?.ticketHash).toBe(createHash("sha256").update(rawTicket).digest("hex"));
    expect(store.issued?.ticketHash).not.toBe(rawTicket);
  });

  it("redeems once and rejects replay", async () => {
    const store = new MemoryTicketStore();
    const tickets = service(store);
    await tickets.issue(identity);

    expect(await tickets.redeem(rawTicket)).toEqual({ ok: true, value: identity });
    const replay = await tickets.redeem(rawTicket);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed tickets before touching storage", async () => {
    const store = new MemoryTicketStore();
    const result = await service(store).redeem("invalid");
    expect(store.consumeCalls).toBe(0);
    expect(result.ok).toBe(false);
  });
});
