import { describe, expect, it, vi } from "vitest";
import * as pveStartModule from "../../src/modules/battle/pve-battle-start.js";
import { createPveBattleStartWhatsAppRoute } from "../../src/modules/battle/pve-battle-start.js";
import { ok } from "../../src/shared-kernel/result.js";

describe("PVE explicit battle-start WhatsApp route", () => {
  it("starts the mentioned trainer active encounter through the canonical orchestrator", async () => {
    const playerId = "11111111-1111-4111-8111-111111111111";
    const encounterId = "22222222-2222-4222-8222-222222222222";
    const battleId = "33333333-3333-4333-8333-333333333333";

    const resolvePlayer = vi.fn(async () =>
      ok({
        playerId,
        state: "COMPLETE",
      }),
    );

    const activeForPlayer = vi.fn(async () =>
      ok({
        encounterId,
        playerId,
        status: "CREATED",
        revision: 0n,
      }),
    );

    const startCanonical = vi.fn(async () => ({
      ok: true as const,
      value: {
        start: {
          battleId,
          replayed: false,
          encounter: {
            encounterId,
            status: "IN_BATTLE",
            revision: 3n,
          },
        },
        initialization: {
          replayed: false,
          state: {
            battleId,
            status: "ACTIVE",
            turnNumber: 1,
          },
        },
      },
    }));

    const factory = (
      pveStartModule as unknown as {
        createPveBattleStartWhatsAppRoute(input: unknown): {
          command: string;
          rateLimitClass?: string;
          policy?: {
            requiredGroupCapabilities?: readonly string[];
            requiredAdminCapability?: string;
          };
          handler: {
            handle(context: unknown): Promise<unknown>;
          };
        };
      }
    ).createPveBattleStartWhatsAppRoute;

    expect(typeof factory).toBe("function");

    const route = factory({
      players: { resolvePlayer },
      encounters: { activeForPlayer },
      start: { startCanonical },
    });

    expect(route.command).toBe("iniciarbatalha");
    expect(route.rateLimitClass).toBe("SENSITIVE");
    expect(route.policy).toMatchObject({
      requiredGroupCapabilities: ["pve"],
      requiredAdminCapability: "encounter.support",
    });

    const result = await route.handler.handle({
      idempotencyKey: "inbox:test:start-pve",
      correlationId: "11111111-1111-4111-8111-111111111111",
      message: {
        provider: "whatsapp",
        senderRef: "admin-wa",
        chatRef: "group-wa",
        text: "/iniciarbatalha @target",
        mentions: ["target-wa"],
      },
    });

    expect(resolvePlayer).toHaveBeenCalledWith({
      provider: "whatsapp",
      externalId: "target-wa",
    });

    expect(activeForPlayer).toHaveBeenCalledWith(playerId);

    expect(startCanonical).toHaveBeenCalledWith({
      playerId,
      encounterId,
      status: "CREATED",
      expectedRevision: 0n,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "BATTLE",
        resultRefId: battleId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: "group-wa",
            messageType: "TEXT",
          },
        ],
      },
    });
  });
  it("confirms an already-started PVE battle despite an enrichment service failure", async () => {
    const playerId = "11111111-1111-4111-8111-111111111111";
    const encounterId = "22222222-2222-4222-8222-222222222222";
    const battleId = "33333333-3333-4333-8333-333333333333";
    const startCanonical = vi.fn(async () => ok({
      start: { battleId, replayed: false },
      initialization: { state: { sides: [], combatants: [], contentReleaseId: "test" } },
    }));
    const listByBattle = vi.fn(async () => {
      throw new Error("Transient PVE controller read failure after battle COMMIT");
    });
    const route = createPveBattleStartWhatsAppRoute({
      players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE" }) },
      encounters: {
        activeForPlayer: async () => ok({ playerId, encounterId, status: "CREATED", revision: 0n }),
      },
      start: { startCanonical },
      controllers: { listByBattle },
      presentation: {
        speciesDisplayName: async () => "Wooper",
        moveDisplayNames: async () => new Map(),
      },
    } as never);
    const result = await route.handler.handle({
      idempotencyKey: "inbox:pve:presentation-failure",
      correlationId: playerId,
      message: {
        provider: "whatsapp",
        senderRef: "narrator-wa",
        chatRef: "group-wa",
        mentions: ["player-wa"],
        text: "/iniciarbatalha @player",
      },
    } as never);
    expect(startCanonical).toHaveBeenCalledTimes(1);
    expect(listByBattle).toHaveBeenCalledWith(battleId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultRefType).toBe("BATTLE");
    expect(result.value.resultRefId).toBe(battleId);
    expect(result.value.outgoing).toHaveLength(1);
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗕𝗔𝗧𝗔𝗟𝗛𝗔");
    expect(result.value.outgoing[0]?.payload.text).toContain("/moves");
  });

});
