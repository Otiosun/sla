import { describe, expect, it, vi } from "vitest";
import type { EncounterView } from "../../src/modules/encounter/contracts.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { FishingAttemptResult } from "../../src/modules/world-services/fishing-service.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createEncounterId, createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000005001";
const ENCOUNTER_ID = createEncounterId();

function context(suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000051${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000052${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000051${suffix}`,
    idempotencyKey: `inbox:baileys:fishing-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `fishing-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000005001@g.us",
      occurredAt: "2026-09-08T00:00:00.000-03:00",
      text: "/pescar",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function encounter(): EncounterView {
  return {
    encounterId: ENCOUNTER_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    status: "CREATED",
    contentReleaseId: "00000000-0000-4000-8000-000000005002",
    rulesetId: "00000000-0000-4000-8000-000000005003",
    creationIdempotencyKey: "encounter.create:fishing-proof",
    rngCounter: 0n,
    revision: 0n,
    createdAt: new Date("2026-09-08T03:00:00.000Z"),
    updatedAt: new Date("2026-09-08T03:00:00.000Z"),
    expiresAt: new Date("2026-09-08T03:10:00.000Z"),
    closedAt: null,
    battleId: null,
    snapshot: {
      schemaVersion: 1,
      formId: "00000000-0000-4000-8000-000000005004",
      speciesId: "00000000-0000-4000-8000-000000005005",
      level: 8,
      type1Id: "00000000-0000-4000-8000-000000005006",
      type2Id: null,
      baseStats: { hp: 55, attack: 45, defense: 45, spAttack: 25, spDefense: 25, speed: 15 },
      ivs: { hp: 1, attack: 2, defense: 3, spAttack: 4, spDefense: 5, speed: 6 },
      natureId: "00000000-0000-4000-8000-000000005007",
      abilityId: "00000000-0000-4000-8000-000000005008",
      moves: [],
      maxHp: 24,
      currentHp: 24,
      shiny: false,
      gender: null,
    },
  };
}

function fishingResult(overrides: Partial<FishingAttemptResult> = {}): FishingAttemptResult {
  return {
    attemptId: "00000000-0000-4000-8000-000000005009",
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    fishingPointName: "Rio dos Arrozais",
    attemptNo: 2,
    dailyLimit: 5,
    remainingAttempts: 3,
    roll: 16,
    rarity: "UNCOMMON",
    replayed: false,
    encounter: encounter(),
    ...overrides,
  };
}

function dependencies(attempt: (input: { playerId: PlayerId; idempotencyKey: string }) => unknown) {
  return {
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      ),
    },
    world: { getLocation: vi.fn() },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession: vi.fn(),
      closeVisit: vi.fn(),
    },
    fishing: { attempt },
  };
}

function fishingRoute(attemptResult: FishingAttemptResult) {
  const attempt = vi.fn(async () => ok(attemptResult));
  const current = dependencies(attempt);
  const routes = createWorldServiceWhatsAppRoutes(current);
  const route = routes.find((definition) => definition.command === "pescar");
  if (route === undefined) throw new Error("Missing route pescar");
  return { route, attempt };
}

describe("Fishing WhatsApp flow", () => {
  it("delegates /pescar to FishingService and renders the three-stage uncommon encounter result", async () => {
    const current = fishingRoute(fishingResult());

    const result = await current.route.handler.handle(context("01"));

    expect(current.attempt).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      idempotencyKey: "inbox:baileys:fishing-01",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing).toHaveLength(3);
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗥𝗜𝗢 𝗗𝗢𝗦 𝗔𝗥𝗥𝗢𝗭𝗔𝗜𝗦");
    expect(result.value.outgoing[1]?.payload.text).toContain("𝗔 𝗕𝗢𝗜𝗔 𝗔𝗙𝗨𝗡𝗗𝗢𝗨");
    expect(result.value.outgoing[2]?.payload.text).toContain("D20");
    expect(result.value.outgoing[2]?.payload.text).toContain("`16`");
    expect(result.value.outgoing[2]?.payload.text).toContain("𝗜𝗡𝗖𝗢𝗠𝗨𝗠");
    expect(result.value.outgoing[2]?.payload.text).toContain("`3/5`");
    expect(result.value.outgoing[2]?.payload.text).toContain("𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢");
    expect(result.value.resultRefId).toBe(ENCOUNTER_ID);
  });

  it("renders a consumed no-encounter attempt without fabricating an encounter", async () => {
    const current = fishingRoute(
      fishingResult({ roll: 9, rarity: null, encounter: null, remainingAttempts: 1 }),
    );

    const result = await current.route.handler.handle(context("02"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing).toHaveLength(2);
    expect(result.value.outgoing[1]?.payload.text).toContain("D20");
    expect(result.value.outgoing[1]?.payload.text).toContain("`9`");
    expect(result.value.outgoing[1]?.payload.text).toContain("`1/5`");
    expect(result.value.outgoing[1]?.payload.text).not.toContain("𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢");
    expect(result.value.resultRefId).toBe("00000000-0000-4000-8000-000000005009");
  });
});
