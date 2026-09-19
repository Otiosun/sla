import { describe, expect, it, vi } from "vitest";
import type { EncounterView } from "../../src/modules/encounter/contracts.js";
import { createSpawnWhatsAppRoute } from "../../src/modules/encounter/spawn-whatsapp.js";
import type { EncounterId, PlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

function context() {
  return {
    inboxMessageId: "11111111-1111-4111-8111-111111111111",
    correlationId: "22222222-2222-4222-8222-222222222222",
    causationId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "spawn:narrated",
    message: {
      provider: "baileys",
      externalMessageId: "spawn-1",
      senderRef: "5511888888888@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-16T12:30:00.000-03:00",
      text: "/spawn @Liora",
      mediaRefs: [],
      mentions: ["5511777777777@s.whatsapp.net"],
      replyToExternalMessageId: null,
    },
  } as never;
}

const playerId = "33333333-3333-4333-8333-333333333333" as PlayerId;
const encounterId = "44444444-4444-4444-8444-444444444444" as EncounterId;

function contextWithText(text: string) {
  const base = context() as unknown as Record<string, unknown> & {
    message: Record<string, unknown>;
  };
  return {
    ...base,
    message: { ...base.message, text },
  } as never;
}

describe("narrator spawn WhatsApp front", () => {
  it("blocks a split party before creating an Encounter", async () => {
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
      encounters: { createOrReplay },
      context: {
        resolve: async () => ({
          kind: "SPLIT",
          groups: [
            { areaDisplayName: "Vila dos Arrozais", participantDisplayNames: ["Liora", "Natan"] },
            { areaDisplayName: "Campos de Yun", participantDisplayNames: ["Kai"] },
          ],
        }),
      },
    } as never);

    const result = await route.handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("*GRUPO DIVIDIDO*");
    expect(text).toContain("*Vila dos Arrozais*");
    expect(text).toContain("*Campos de Yun*");
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it("uses WhatsApp typography and hides technical identifiers", async () => {
    const created = {
      encounterId,
      playerId,
      participantPlayerIds: [playerId],
      areaId: "55555555-5555-4555-8555-555555555555",
      contentReleaseId: "66666666-6666-4666-8666-666666666666",
      rulesetId: "77777777-7777-4777-8777-777777777777",
      status: "CREATED",
      rngCounter: 1n,
      revision: 0n,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000),
      closedAt: null,
      snapshot: {
        schemaVersion: 1,
        speciesId: "88888888-8888-4888-8888-888888888888",
        formId: "99999999-9999-4999-8999-999999999999",
        level: 6,
      },
      battleId: null,
    } as unknown as EncounterView;

    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
      encounters: {
        createOrReplay: async () => ok(created),
        observe: async () => ok({ ...created, status: "PRESENTED", revision: 1n }),
      },
      context: {
        resolve: async () => ({
          kind: "READY",
          areaDisplayName: "Vila dos Arrozais",
          participantCount: 2,
        }),
      },
      speciesDisplayName: async () => "Bellsprout",
    });

    const result = await route.handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("🌿 *ENCONTRO SELVAGEM*");
    expect(text).toContain("_Cena conduzida pelo narrador em Vila dos Arrozais._");
    expect(text).toContain("*Bellsprout* · Nv. 6");
    expect(text).toContain("2 treinadores");
    expect(text).toContain("`/iniciarbatalha @treinador`");
    expect(text).not.toContain(encounterId);
    expect(text.toLowerCase()).not.toContain("revision");
  });

  it("blocks a travelling party before creating an Encounter", async () => {
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      encounters: { createOrReplay },
      context: {
        resolve: async () => ({
          kind: "TRAVELLING",
          participantDisplayNames: ["Liora", "Kai"],
        }),
      },
    } as never);

    const result = await route.handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("*GRUPO EM DESLOCAMENTO*");
    expect(text).toContain("Liora");
    expect(text).toContain("Kai");
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it("accepts narrator quantity and renders the frozen wild roster", async () => {
    const created = {
      encounterId,
      playerId,
      areaId: "55555555-5555-4555-8555-555555555555",
      contentReleaseId: "66666666-6666-4666-8666-666666666666",
      rulesetId: "77777777-7777-4777-8777-777777777777",
      status: "CREATED",
      rngCounter: 8n,
      revision: 0n,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000),
      closedAt: null,
      snapshot: { schemaVersion: 1, speciesId: "species-a", level: 5 },
      wilds: [
        {
          wildNo: 1,
          status: "ACTIVE",
          snapshot: { schemaVersion: 1, speciesId: "species-a", level: 5 },
        },
        {
          wildNo: 2,
          status: "ACTIVE",
          snapshot: { schemaVersion: 1, speciesId: "species-b", level: 7 },
        },
        {
          wildNo: 3,
          status: "ACTIVE",
          snapshot: { schemaVersion: 1, speciesId: "species-c", level: 6 },
        },
      ],
      battleId: null,
    } as unknown as EncounterView;

    const createOrReplay = vi.fn(async () => ok(created));
    const route = createSpawnWhatsAppRoute({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      encounters: {
        createOrReplay,
        observe: async () => ok({ ...created, status: "PRESENTED", revision: 1n }),
      },
      context: {
        resolve: async () => ({
          kind: "READY",
          areaDisplayName: "Campos de Yun",
          participantCount: 1,
        }),
      },
      speciesDisplayName: async (_release, speciesId) =>
        new Map([
          ["species-a", "Oddish"],
          ["species-b", "Ponyta"],
          ["species-c", "Hoppip"],
        ]).get(speciesId) ?? null,
    });

    const multiContext = contextWithText("/spawn @Liora 3");

    const result = await route.handler.handle(multiContext);
    expect(result.ok).toBe(true);
    expect(createOrReplay).toHaveBeenCalledWith(expect.objectContaining({ spawnQuantity: 3 }));
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("*ENCONTRO SELVAGEM · GRUPO*");
    expect(text).toContain("1. *Oddish* · Nv. 5");
    expect(text).toContain("2. *Ponyta* · Nv. 7");
    expect(text).toContain("3. *Hoppip* · Nv. 6");
  });

  it("rejects narrator spawn quantities outside 1..6 before consuming encounter RNG", async () => {
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      encounters: { createOrReplay },
    } as never);

    const invalid = contextWithText("/spawn @Liora 7");

    const result = await route.handler.handle(invalid);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(createOrReplay).not.toHaveBeenCalled();
  });
});
