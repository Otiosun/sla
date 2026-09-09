import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import {
  HubLoginTicketService,
  type HubLoginTicketRecord,
  type HubLoginTicketStore,
} from "../../src/modules/player-portal/login-ticket-service.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
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
const issuedAt = new Date("2026-09-09T12:00:00.000Z");

function service(store: HubLoginTicketStore, now = issuedAt): HubLoginTicketService {
  return new HubLoginTicketService(store, {
    now: () => now,
    generateToken: () => rawTicket,
  });
}

describe("HubLoginTicketService", () => {
  it("issues an opaque ticket while storing only its SHA-256 hash", async () => {
    const store = new MemoryTicketStore();

    const result = await service(store).issue(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket).toBe(rawTicket);
    expect(result.value.expiresAt.toISOString()).toBe("2026-09-09T12:05:00.000Z");
    expect(store.issued).not.toBeNull();
    expect(store.issued?.ticketHash).toBe(
      createHash("sha256").update(rawTicket).digest("hex"),
    );
    expect(store.issued?.ticketHash).not.toBe(rawTicket);
    expect(store.issued?.identity).toEqual(identity);
  });

  it("redeems a valid ticket once and rejects replay", async () => {
    const store = new MemoryTicketStore();
    const tickets = service(store);
    await tickets.issue(identity);

    const first = await tickets.redeem(rawTicket);
    const replay = await tickets.redeem(rawTicket);

    expect(first).toEqual({ ok: true, value: identity });
    expect(replay).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Hub login ticket unavailable",
      },
    });
  });

  it("rejects an expired ticket through the atomic consume boundary", async () => {
    const store = new MemoryTicketStore();
    await service(store).issue(identity);

    const result = await service(
      store,
      new Date("2026-09-09T12:05:00.000Z"),
    ).redeem(rawTicket);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Hub login ticket unavailable",
      },
    });
  });

  it("rejects malformed tickets before touching the store", async () => {
    const store = new MemoryTicketStore();

    const result = await service(store).redeem("not a ticket");

    expect(store.consumeCalls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects malformed external identities before issuing a ticket", async () => {
    const store = new MemoryTicketStore();

    const result = await service(store).issue({
      provider: "Whats App",
      externalId: "",
    });

    expect(store.issued).toBeNull();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
