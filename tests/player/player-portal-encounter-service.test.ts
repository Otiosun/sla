import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalEncounterService } from "../../src/modules/player-portal/encounter-service.js";
import { createEncounterId, createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

function encounterView(playerId: string, encounterId: string, revision: bigint) {
  return {
    encounterId,
    playerId,
    areaId: "11111111-1111-4111-8111-111111111111",
    status: "PRESENTED" as const,
    contentReleaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    rulesetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    creationIdempotencyKey: "stored-key",
    rngCounter: 4n,
    revision,
    createdAt: new Date("2026-09-09T18:00:00.000Z"),
    updatedAt: new Date("2026-09-09T18:01:00.000Z"),
    expiresAt: new Date("2026-09-09T18:05:00.000Z"),
    closedAt: null,
    battleId: null,
    snapshot: {
      schemaVersion: 1 as const,
      formId: "22222222-2222-4222-8222-222222222222",
      speciesId: "33333333-3333-4333-8333-333333333333",
      level: 5,
      type1Id: "44444444-4444-4444-8444-444444444444",
      type2Id: null,
      baseStats: { hp: 45, attack: 49, defense: 49, spAttack: 65, spDefense: 65, speed: 45 },
      ivs: { hp: 10, attack: 11, defense: 12, spAttack: 13, spDefense: 14, speed: 15 },
      natureId: "55555555-5555-4555-8555-555555555555",
      abilityId: "66666666-6666-4666-8666-666666666666",
      moves: [{ moveId: "77777777-7777-4777-8777-777777777777", ppCurrent: 35 }],
      maxHp: 21,
      currentHp: 21,
      shiny: false as const,
      gender: null,
    },
  };
}

describe("PlayerPortalEncounterService", () => {
  it("creates an encounter for the authenticated player and returns only portal-safe presentation", async () => {
    const playerId = createPlayerId();
    const encounterId = createEncounterId();
    let createInput: unknown = null;
    const service = new PlayerPortalEncounterService(
      {
        read: async (work: (transaction: unknown) => Promise<unknown>) =>
          work({ findPlayerByIdentity: async () => playerId }),
      } as never,
      {
        createOrReplay: async (input: unknown) => {
          createInput = input;
          return ok(encounterView(playerId, encounterId, 2n));
        },
      } as never,
      {
        resolve: async () => ({
          originRegionName: null,
          forms: [
            {
              formId: "22222222-2222-4222-8222-222222222222",
              displayName: "Bulbasaur",
              nationalDex: 1,
              typeNames: ["Grass", "Poison"],
            },
          ],
        }),
      },
    );

    const result = await service.create(identity, {
      idempotencyKey: "hub-encounter-00000001",
      encounterTableSlug: "grass",
    });

    expect(createInput).toEqual({
      playerId,
      idempotencyKey: "hub-encounter-00000001",
      encounterTableSlug: "grass",
    });
    expect(result).toEqual(
      ok({
        encounterId,
        areaId: "11111111-1111-4111-8111-111111111111",
        status: "PRESENTED",
        revision: "2",
        createdAt: "2026-09-09T18:00:00.000Z",
        updatedAt: "2026-09-09T18:01:00.000Z",
        expiresAt: "2026-09-09T18:05:00.000Z",
        closedAt: null,
        wild: {
          formId: "22222222-2222-4222-8222-222222222222",
          displayName: "Bulbasaur",
          nationalDex: 1,
          typeNames: ["Grass", "Poison"],
          level: 5,
          currentHp: 21,
          maxHp: 21,
          shiny: false,
          gender: null,
        },
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const json = JSON.stringify(result.value);
    expect(json).not.toContain("playerId");
    expect(json).not.toContain("contentReleaseId");
    expect(json).not.toContain("rulesetId");
    expect(json).not.toContain("abilityId");
    expect(json).not.toContain("natureId");
  });

  it("injects authenticated player and bigint revision into encounter mutations", async () => {
    const playerId = createPlayerId();
    const encounterId = createEncounterId();
    let mutationInput: unknown = null;
    const service = new PlayerPortalEncounterService(
      {
        read: async (work: (transaction: unknown) => Promise<unknown>) =>
          work({ findPlayerByIdentity: async () => playerId }),
      } as never,
      {
        flee: async (input: unknown) => {
          mutationInput = input;
          return ok({ ...encounterView(playerId, encounterId, 3n), status: "FLED" as const });
        },
      } as never,
      { resolve: async () => ({ originRegionName: null, forms: [] }) },
    );

    const result = await service.flee(identity, {
      encounterId,
      expectedRevision: "2",
    });

    expect(mutationInput).toEqual({ playerId, encounterId, expectedRevision: 2n });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("FLED");
    expect(result.value.revision).toBe("3");
  });
});
