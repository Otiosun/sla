import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EconomyService } from "../../src/modules/economy/service.js";
import type { EconomyRepository } from "../../src/modules/economy/ports.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

function unusedRepository(): EconomyRepository {
  return {
    async transaction() {
      throw new Error("repository should not be called for invalid input");
    },
    async read() {
      throw new Error("repository should not be called for invalid input");
    },
  };
}

function metadata() {
  return {
    sourceType: "TEST",
    sourceId: "unit-test",
    reason: "validate economy boundary",
    actorType: "SYSTEM" as const,
    actorId: null,
    correlationId: randomUUID(),
  };
}

describe("economy service boundary validation", () => {
  const playerId = createPlayerId();
  const itemId = randomUUID();
  const currencyId = randomUUID();

  it("rejects zero, negative and values outside PostgreSQL BIGINT before persistence", async () => {
    const service = new EconomyService(unusedRepository());
    for (const quantity of [0n, -1n, 9_223_372_036_854_775_808n]) {
      await expect(
        service.addItem({
          playerId,
          itemId,
          quantity,
          idempotencyKey: `invalid-${quantity}`,
          metadata: metadata(),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    await expect(
      service.creditWallet({
        playerId,
        currencyId,
        amount: 9_223_372_036_854_775_808n,
        idempotencyKey: "wallet-overflow",
        metadata: metadata(),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("requires auditable actor/reason/correlation metadata", async () => {
    const service = new EconomyService(unusedRepository());
    await expect(
      service.addItem({
        playerId,
        itemId,
        quantity: 1n,
        idempotencyKey: "bad-admin-metadata",
        metadata: {
          ...metadata(),
          reason: "",
          actorType: "ADMIN",
          actorId: null,
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("rejects malformed offer keys and malformed domain identifiers", async () => {
    const service = new EconomyService(unusedRepository());
    await expect(
      service.purchase({
        playerId,
        offerKey: "INVALID OFFER",
        idempotencyKey: "invalid-offer",
        metadata: metadata(),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      service.consumeItem({
        playerId,
        itemId: "not-a-uuid",
        quantity: 1n,
        idempotencyKey: "invalid-item",
        metadata: metadata(),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});
