import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import {
  createAdminBatchWhatsAppRoutes,
  type AdminWhatsAppBatchDependencies,
} from "../../src/modules/admin/whatsapp-batch-handlers.js";

const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000001";
const PLAYER_ID = "00000000-0000-4000-8000-000000000002";
const BATCH_ID = "00000000-0000-4000-8000-000000000003";
const CURRENCY_ID = "00000000-0000-4000-8000-000000000004";

function context(
  text: string,
  options: {
    mentions?: string[];
    replyToExternalMessageId?: string | null;
  } = {},
): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000101",
    correlationId: "00000000-0000-4000-8000-000000000102",
    causationId: "00000000-0000-4000-8000-000000000101",
    idempotencyKey: "inbox:baileys:admin-batch-test",
    message: {
      provider: "baileys",
      externalMessageId: "admin-batch-inbound",
      senderRef: "admin@s.whatsapp.net",
      chatRef: "group@g.us",
      occurredAt: "2026-09-25T18:00:00.000Z",
      text,
      mentions: options.mentions ?? [],
      mediaRefs: [],
      replyToExternalMessageId: options.replyToExternalMessageId ?? null,
    },
  };
}

function dependencies(): AdminWhatsAppBatchDependencies {
  const prepareMutation = vi.fn(async (input: Readonly<Record<string, unknown>>) => ({
    operation: {
      id: input.operationType === "batch.preview" ? BATCH_ID : "00000000-0000-4000-8000-000000000005",
      status: input.operationType === "batch.preview" ? "READY" : "PENDING_CONFIRMATION",
    },
    replayed: false,
  }));
  const apply = vi.fn(async (operationId: string) => ({
    id: operationId,
    status: "APPLIED",
    result:
      operationId === BATCH_ID
        ? {
            batchId: BATCH_ID,
            targetCount: 1,
            revision: "0",
          }
        : {
            targetCount: 1,
            successCount: 1,
            failureCount: 0,
            failures: [],
          },
  }));
  const confirm = vi.fn(async (operationId: string) => ({
    id: operationId,
    status: "READY",
    result: null,
  }));

  return {
    admins: {
      resolvePrincipal: vi.fn(async () => ({ principalId: PRINCIPAL_ID })),
      capabilitiesFor: vi.fn(async () => [
        "central.view",
        "player.read",
        "batch.preview",
        "batch.execute.low_risk",
        "wallet.adjust",
        "economy.read",
      ]),
    },
    targets: {
      resolveExternalRefs: vi.fn(async () => [
        { playerId: PLAYER_ID, trainerName: "Ana" },
      ]),
      resolveTrainerName: vi.fn(async () => ({ status: "MISSING" as const })),
    },
    catalog: {
      get: vi.fn(async () => ({
        items: [],
        currencies: [
          {
            currencyId: CURRENCY_ID,
            slug: "pokedollar",
            displayName: "PokéDollar",
            allowsNegative: false,
          },
        ],
        species: [],
      })),
    },
    admin: {
      prepareMutation,
      apply,
      confirm,
    },
    previewRefs: {
      findByProviderMessage: vi.fn(async () => ({
        provider: "baileys",
        providerExternalMessageId: "preview-message",
        outboxMessageId: "00000000-0000-4000-8000-000000000006",
        adminPrincipalId: PRINCIPAL_ID,
        chatRef: "group@g.us",
        batchId: BATCH_ID,
        batchRevision: "0",
        reason: "recompensa do evento",
      })),
    },
  } as unknown as AdminWhatsAppBatchDependencies;
}

describe("admin WhatsApp batch routes", () => {
  it("shows only the administrative actions available to the sender", async () => {
    const deps = dependencies();
    const [route] = createAdminBatchWhatsAppRoutes(deps);
    if (route === undefined) throw new Error("ADM route missing");

    const result = await route.handler.handle(context("/adm"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("/adm dinheiro");
    expect(text).not.toContain("/adm item");
    expect(text).not.toContain("/adm visto");
  });

  it("creates a frozen preview without executing the child reward", async () => {
    const deps = dependencies();
    const [route] = createAdminBatchWhatsAppRoutes(deps);
    if (route === undefined) throw new Error("ADM route missing");

    const result = await route.handler.handle(
      context("/adm dinheiro +500 para @Ana | recompensa do evento", {
        mentions: ["ana@s.whatsapp.net"],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.admin.prepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "batch.preview",
        reason: "recompensa do evento",
      }),
    );
    expect(deps.admin.apply).toHaveBeenCalledTimes(1);
    expect(deps.admin.confirm).not.toHaveBeenCalled();
    const outgoing = result.value.outgoing[0];
    expect(String(outgoing?.payload.text ?? "")).toContain("Nada foi aplicado ainda");
    expect(outgoing?.payload.adminBatchPreview).toEqual({
      adminPrincipalId: PRINCIPAL_ID,
      batchId: BATCH_ID,
      batchRevision: "0",
    });
  });

  it("requires the confirmation command to reply to a delivered preview", async () => {
    const deps = dependencies();
    const [route] = createAdminBatchWhatsAppRoutes(deps);
    if (route === undefined) throw new Error("ADM route missing");

    const result = await route.handler.handle(context("/adm confirmar"));

    expect(result.ok).toBe(false);
    expect(deps.admin.prepareMutation).not.toHaveBeenCalled();
  });

  it("executes the same frozen batch only after replying to its preview", async () => {
    const deps = dependencies();
    const [route] = createAdminBatchWhatsAppRoutes(deps);
    if (route === undefined) throw new Error("ADM route missing");

    const result = await route.handler.handle(
      context("/adm confirmar", { replyToExternalMessageId: "preview-message" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.admin.prepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "batch.execute.low_risk",
        input: { batchId: BATCH_ID },
        expectedRevision: 0n,
        reason: "recompensa do evento",
      }),
    );
    expect(deps.admin.confirm).toHaveBeenCalledTimes(1);
    expect(deps.admin.apply).toHaveBeenCalledTimes(1);
    expect(String(result.value.outgoing[0]?.payload.text ?? "")).toContain("LOTE APLICADO");
  });
});
