import { describe, expect, it, vi } from "vitest";
import { createSpawnWhatsAppRoute } from "../../src/modules/encounter/spawn-whatsapp.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = "11111111-1111-4111-8111-111111111111" as never;
const encounterId = "22222222-2222-4222-8222-222222222222" as never;

function context(mentions: readonly string[]): MessageHandlerContext {
  return {
    inboxMessageId: "inbox",
    correlationId: "33333333-3333-4333-8333-333333333333",
    causationId: "cause",
    idempotencyKey: "inbox:baileys:spawn-1",
    message: {
      provider: "baileys",
      externalMessageId: "spawn-1",
      senderRef: "narrator@s.whatsapp.net",
      chatRef: "group@g.us",
      occurredAt: "2026-09-10T00:00:00.000Z",
      text: "/spawn @target",
      mentions: [...mentions],
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function contextWithText(text: string, mentions: readonly string[]): MessageHandlerContext {
  const base = context(mentions);
  return {
    ...base,
    message: {
      ...base.message,
      text,
    },
  };
}

describe("PVE /spawn WhatsApp route", () => {
  it("requires exactly one provider mention before resolving a player or consuming RNG", async () => {
    const resolvePlayer = vi.fn();
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
    } as never);

    const output = await route.handler.handle(context([]));

    expect(output).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(resolvePlayer).not.toHaveBeenCalled();
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it("uses the actual marked WhatsApp identity and makes the marked player capture owner", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        snapshot: { level: 7 },
      }),
    );
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
    } as never);

    const output = await route.handler.handle(context(["target@s.whatsapp.net"]));

    expect(resolvePlayer).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: "target@s.whatsapp.net",
    });
    expect(createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        participantPlayerIds: [],
        idempotencyKey: "inbox:baileys:spawn-1",
      }),
    );
    expect(output).toMatchObject({ ok: true, value: { resultRefId: encounterId } });
  });

  it("returns a visible feature error when the encounter environment is not configured", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn();
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
      environment: () => {
        throw new Error("BELL_WORLD_TIME_OF_DAY must be explicitly set to DAY or NIGHT");
      },
    } as never);

    const output = await route.handler.handle(context(["target@s.whatsapp.net"]));

    expect(output).toMatchObject({
      ok: false,
      error: {
        code: "FEATURE_UNAVAILABLE",
        details: {
          userMessage: expect.stringContaining("DAY/NIGHT"),
        },
      },
    });
    expect(createOrReplay).not.toHaveBeenCalled();
  });

  it("resolves a forced species and starts an automatic battle for the marked trainer", async () => {
    const battleId = "44444444-4444-4444-8444-444444444444";
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        contentReleaseId: "55555555-5555-4555-8555-555555555555",
        revision: 0n,
        snapshot: {
          speciesId: "66666666-6666-4666-8666-666666666666",
          level: 7,
        },
      }),
    );
    const observe = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        contentReleaseId: "55555555-5555-4555-8555-555555555555",
        revision: 1n,
        status: "PRESENTED",
        snapshot: {
          speciesId: "66666666-6666-4666-8666-666666666666",
          level: 7,
        },
      }),
    );
    const species = {
      resolve: vi.fn().mockResolvedValue({
        formId: "77777777-7777-4777-8777-777777777777",
        displayName: "Poochyena",
      }),
    };
    const start = vi.fn().mockResolvedValue({ ok: true, value: { battleId } });
    const automatePlayers = vi.fn().mockResolvedValue({ automated: 1 });
    const kick = vi.fn().mockResolvedValue([]);

    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay, observe },
      species,
      environment: () => ({
        timeOfDay: "NIGHT",
        surface: "LAND",
        rarity: "COMMON",
      }),
      speciesDisplayName: async () => "Poochyena",
      autoBattle: { start, automatePlayers, kick },
    } as never);

    const output = await route.handler.handle(
      contextWithText("/spawn auto Poochyena @target", ["target@s.whatsapp.net"]),
    );

    expect(species.resolve).toHaveBeenCalledWith("Poochyena");
    expect(createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        forcedFormId: "77777777-7777-4777-8777-777777777777",
        spawnQuantity: 1,
        environment: {
          timeOfDay: "NIGHT",
          surface: "LAND",
          rarity: "COMMON",
        },
      }),
    );
    expect(start).toHaveBeenCalledWith({
      playerId,
      encounterId,
      status: "PRESENTED",
      expectedRevision: 1n,
    });
    expect(automatePlayers).toHaveBeenCalledWith(battleId);
    expect(kick).toHaveBeenCalledWith(battleId);
    expect(output).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: battleId,
      },
    });
    if (output.ok) {
      const text = String(output.value.outgoing[0]?.payload.text ?? "");
      expect(text).toContain("BATALHA AUTOMÁTICA");
      expect(text).toContain("controle da IA");
      expect(output.value.outgoing[0]?.payload.mentions).toEqual(["target@s.whatsapp.net"]);
    }
  });
  it("forwards forced level, shiny and first-turn overrides without changing random environment context", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        contentReleaseId: "55555555-5555-4555-8555-555555555555",
        revision: 0n,
        snapshot: {
          speciesId: "66666666-6666-4666-8666-666666666666",
          level: 12,
          shiny: true,
          moves: [],
        },
      }),
    );
    const observe = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        contentReleaseId: "55555555-5555-4555-8555-555555555555",
        revision: 1n,
        status: "PRESENTED",
        snapshot: {
          speciesId: "66666666-6666-4666-8666-666666666666",
          level: 12,
          shiny: true,
          moves: [],
        },
      }),
    );
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay, observe },
      species: {
        resolve: vi.fn(async () => ({
          formId: "77777777-7777-4777-8777-777777777777",
          displayName: "Poochyena",
        })),
      },
      environment: () => ({ timeOfDay: "NIGHT", surface: "LAND", rarity: "COMMON" }),
      speciesDisplayName: async () => "Poochyena",
      context: {
        resolve: async () => ({
          kind: "READY" as const,
          areaDisplayName: "Vila dos Arrozais",
          participantCount: 1,
        }),
      },
    } as never);

    const output = await route.handler.handle(
      contextWithText("/spawn Poochyena @target nv 12 shiny inicio selvagem", [
        "target@s.whatsapp.net",
      ]),
    );

    expect(createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId,
        forcedLevel: 12,
        forcedShiny: true,
        firstTurnInitiative: "WILD",
        environment: {
          timeOfDay: "NIGHT",
          surface: "LAND",
          rarity: "COMMON",
        },
      }),
    );
    if (!output.ok) throw new Error("expected forced spawn success");
    const text = String(output.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("*Poochyena* ✦ · Nv. `12`");
    expect(text).toContain("@target");
    expect(output.value.outgoing[0]?.payload.mentions).toEqual(["target@s.whatsapp.net"]);
  });

  it("starts the fast narrator path and registers the chosen opening move", async () => {
    const battleId = "44444444-4444-4444-8444-444444444444";
    const releaseId = "55555555-5555-4555-8555-555555555555";
    const speciesId = "66666666-6666-4666-8666-666666666666";
    const formId = "77777777-7777-4777-8777-777777777777";
    const biteId = "88888888-8888-4888-8888-888888888888";
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const view = {
      encounterId,
      contentReleaseId: releaseId,
      revision: 1n,
      status: "PRESENTED",
      snapshot: {
        speciesId,
        level: 9,
        shiny: false,
        moves: [{ moveId: biteId, ppCurrent: 25 }],
      },
      wilds: [
        {
          wildNo: 1,
          status: "ACTIVE",
          snapshot: {
            speciesId,
            level: 9,
            shiny: false,
            moves: [{ moveId: biteId, ppCurrent: 25 }],
          },
        },
      ],
    };
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: {
        createOrReplay: vi.fn(async () => ok({ ...view, revision: 0n, status: "CREATED" })),
        observe: vi.fn(async () => ok(view)),
      },
      species: {
        resolve: vi.fn(async () => ({ formId, displayName: "Poochyena" })),
      },
      speciesDisplayName: async () => "Poochyena",
      moveDisplayNames: async (_release: string, ids: readonly string[]) =>
        new Map(ids.map((id: string) => [id, id === biteId ? "Bite" : "Water Gun"])),
      context: {
        resolve: async () => ({
          kind: "READY" as const,
          areaDisplayName: "Vila dos Arrozais",
          participantCount: 1,
        }),
      },
      narratorOpening: {
        start: vi.fn(async () => ({
          ok: true as const,
          value: {
            battleId,
            moveDisplayName: "Bite",
            player: {
              displayName: "Mudkip",
              level: 5,
              shiny: false,
              currentHp: 21,
              maxHp: 21,
              moves: [
                {
                  slotNo: 1,
                  displayName: "Water Gun",
                  ppCurrent: 25,
                  maxPp: 25,
                },
              ],
            },
          },
        })),
      },
    } as never);

    const output = await route.handler.handle(
      contextWithText("/spawn Poochyena @target nv 9 ataque Bite", ["target@s.whatsapp.net"]),
    );

    expect(route.allowEmbedded).toBe(true);
    const opening = route as never as { handler: unknown };
    expect(opening).toBeDefined();
    if (!output.ok) throw new Error("expected fast spawn success");
    expect(output.value.resultRefType).toBe("BATTLE");
    expect(output.value.resultRefId).toBe(battleId);
    const text = String(output.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("✦ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔*");
    expect(text).toContain("Bite já foi definido pelo selvagem");
    expect(text).toContain("`/moves`");
    expect(text).not.toContain("*Seus golpes*");
    expect(text).not.toContain("Water Gun");
    expect(text).toContain("@target");
  });

  it("rolls back a fast-path spawn when the requested opening move is unavailable", async () => {
    const releaseId = "55555555-5555-4555-8555-555555555555";
    const speciesId = "66666666-6666-4666-8666-666666666666";
    const biteId = "88888888-8888-4888-8888-888888888888";
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const view = {
      encounterId,
      contentReleaseId: releaseId,
      revision: 1n,
      status: "PRESENTED",
      snapshot: {
        speciesId,
        level: 9,
        shiny: false,
        moves: [{ moveId: biteId, ppCurrent: 25 }],
      },
      wilds: [
        {
          wildNo: 1,
          status: "ACTIVE",
          snapshot: {
            speciesId,
            level: 9,
            shiny: false,
            moves: [{ moveId: biteId, ppCurrent: 25 }],
          },
        },
      ],
    };
    const flee = vi.fn(async () => ok({ ...view, status: "FLED", revision: 1n }));
    const observe = vi.fn(async () => ok(view));
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: {
        createOrReplay: vi.fn(async () => ok({ ...view, revision: 0n, status: "CREATED" })),
        observe,
        flee,
      },
      species: {
        resolve: vi.fn(async () => ({
          formId: "77777777-7777-4777-8777-777777777777",
          displayName: "Poochyena",
        })),
      },
      moveDisplayNames: async () => new Map([[biteId, "Bite"]]),
      narratorOpening: {
        start: vi.fn(async () => {
          throw new Error("opening start must not run for an invalid move");
        }),
      },
    } as never);

    const output = await route.handler.handle(
      contextWithText("/spawn Poochyena @target ataque Crunch", ["target@s.whatsapp.net"]),
    );

    expect(output.ok).toBe(false);
    expect(flee).toHaveBeenCalledWith({
      playerId,
      encounterId,
      expectedRevision: 0n,
    });
    expect(observe).not.toHaveBeenCalled();
    if (!output.ok) {
      expect(String(output.error.details?.userMessage ?? "")).toContain(
        "nenhum encontro ficou preso",
      );
    }
  });

  it("reports the real active-encounter cause instead of claiming a forced species is unavailable", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: {
        createOrReplay: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "FLOW_BLOCKED",
            message: "Player already has an incompatible active encounter",
          },
        })),
      },
      species: {
        resolve: vi.fn(async () => ({
          formId: "77777777-7777-4777-8777-777777777777",
          displayName: "Poochyena",
        })),
      },
    } as never);

    const output = await route.handler.handle(
      contextWithText("/spawn Poochyena @target", ["target@s.whatsapp.net"]),
    );
    expect(output).toMatchObject({
      ok: false,
      error: {
        details: {
          userMessage: expect.stringContaining("encontro ativo"),
        },
      },
    });
    if (!output.ok) {
      expect(String(output.error.details?.userMessage ?? "")).not.toContain(
        "Poochyena não está disponível",
      );
    }
  });

  it("accepts /spawn embedded at the end of a human-written scene without touching the prose", async () => {
    const resolvePlayer = vi
      .fn()
      .mockResolvedValue(ok({ playerId, state: "COMPLETE", created: false }));
    const createOrReplay = vi.fn().mockResolvedValue(
      ok({
        encounterId,
        contentReleaseId: "55555555-5555-4555-8555-555555555555",
        revision: 1n,
        status: "PRESENTED",
        snapshot: {
          speciesId: "66666666-6666-4666-8666-666666666666",
          level: 7,
          shiny: false,
          moves: [],
        },
      }),
    );
    const route = createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
      species: {
        resolve: vi.fn(async () => ({
          formId: "77777777-7777-4777-8777-777777777777",
          displayName: "Poochyena",
        })),
      },
      speciesDisplayName: async () => "Poochyena",
    } as never);
    const router = new MessageRouter([route], { authorize: async () => ok(undefined) });
    const scene =
      "*Poochyena rompeu o mato e avançou contra o treinador.*\n\n/spawn Poochyena @target nv 7";
    const output = await router.dispatch(contextWithText(scene, ["target@s.whatsapp.net"]));

    expect(output.ok).toBe(true);
    expect(createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        forcedLevel: 7,
        forcedFormId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    expect(scene).toContain("Poochyena rompeu o mato");
    if (!output.ok || output.value === null) throw new Error("expected embedded spawn success");
    const text = String(output.value.outgoing[0]?.payload.text ?? "");
    expect(text).toContain("◇ *𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗦𝗘𝗟𝗩𝗔𝗚𝗘𝗠*");
    expect(text).not.toContain("/iniciarbatalha");
  });
});
