import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPvpGroupTimingRoute } from "../../src/modules/pvp/group-timing.js";

function fixture() {
  const principalId = randomUUID(),
    groupId = randomUUID(),
    operationId = randomUUID();
  const context: MessageHandlerContext = {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:timing-restart",
    message: {
      provider: "baileys",
      externalMessageId: "timing-restart",
      senderRef: "5511999990001@s.whatsapp.net",
      chatRef: "120363777700000001@g.us",
      occurredAt: "2026-11-04T00:00:00Z",
      text: "/pvp prazo 2",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
  const previous = {
    id: operationId,
    principalId,
    operationType: "community.group.pvp_timing",
    input: { groupId, turnTtlMs: 7200000 },
  } as unknown as AdminOperationRecord;
  const prepareMutation = vi.fn(async () => ({ operation: previous, replayed: false }));
  const apply = vi.fn(async () => previous);
  const operationForKey = vi.fn(async (): Promise<AdminOperationRecord | null> => null);
  const getGroupConfigurationByProviderRef = vi.fn(async () => ({
    id: groupId,
    provider: "baileys",
    chatRef: context.message.chatRef,
    role: "GAME" as const,
    displayName: "Synthetic",
    status: "ACTIVE" as const,
    revision: 2,
    capabilities: ["pvp" as const],
  }));
  const route = createPvpGroupTimingRoute({
    admins: { resolvePrincipal: async () => ({ principalId }) },
    admin: { prepareMutation, apply },
    operationForKey,
    community: { getGroupConfigurationByProviderRef },
  });
  return {
    context,
    previous,
    route,
    prepareMutation,
    apply,
    operationForKey,
    getGroupConfigurationByProviderRef,
  };
}
describe("candidate PvP group timing command", () => {
  it("recovers the original operation after its group revision has changed", async () => {
    const f = fixture();
    f.operationForKey.mockResolvedValue(f.previous);
    expect(await f.route.handler.handle(f.context)).toMatchObject({ ok: true });
    expect(f.prepareMutation).not.toHaveBeenCalled();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(f.previous.id, f.previous.principalId);
  });
  it("rejects a changed replay before applying an administrative operation", async () => {
    const f = fixture();
    f.operationForKey.mockResolvedValue(f.previous);
    expect(
      await f.route.handler.handle({
        ...f.context,
        message: { ...f.context.message, text: "/pvp prazo 3" },
      }),
    ).toMatchObject({ ok: false, error: { code: "FINGERPRINT_MISMATCH" } });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "Infinity", "1e3", "99999999999999999"])(
    "rejects invalid hours %s without preparing a mutation",
    async (hours) => {
      const f = fixture();
      expect(
        await f.route.handler.handle({
          ...f.context,
          message: { ...f.context.message, text: "/pvp prazo " + hours },
        }),
      ).toMatchObject({ ok: false });
      expect(f.prepareMutation).not.toHaveBeenCalled();
    },
  );
});
