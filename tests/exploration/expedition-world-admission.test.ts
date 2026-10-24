import { describe, expect, it } from "vitest";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { WorldLocationView } from "../../src/modules/world/contracts.js";
import {
  inspectExplorationWorld,
  type PublishedExplorationAreas,
} from "../../src/modules/exploration/expedition-world-admission.js";

const playerId = createPlayerId();
const releaseId = "release-published-01";
const villageId = "area-vila";
const yunId = "area-yun";

function location(): WorldLocationView {
  return {
    playerId,
    contentReleaseId: releaseId,
    areaId: villageId,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "region-zhoulia",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    facilities: ["POKEMART", "POKEMON_CENTER"],
    revision: 4n,
    enteredAt: new Date("2026-10-24T12:00:00Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [
      {
        connectionId: "route-yun",
        connectionKey: "vila-to-yun",
        destinationAreaId: yunId,
        destinationSlug: "campos-de-yun",
        destinationDisplayName: "Campos de Yun",
        available: true,
        missingUnlockKeys: [],
      },
    ],
  };
}

function published(): PublishedExplorationAreas {
  return {
    contentReleaseId: releaseId,
    encounterReadyAreaIds: [villageId, yunId],
  };
}

describe("individual exploration - canonical world read-only admission", () => {
  it("admits the village and displays only the actually connected published destination", () => {
    const original = location();
    const result = inspectExplorationWorld({
      playerId,
      location: original,
      publishedAreas: published(),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        currentAreaSlug: "vila-dos-arrozais",
        contentReleaseId: releaseId,
        availableDestinations: [
          { areaId: yunId, areaSlug: "campos-de-yun", connectionId: "route-yun" },
        ],
      },
    });
    expect(original.revision).toBe(4n);
    expect(original.connections).toHaveLength(1);
  });

  it("refuses another player's location and an unknown active content release", () => {
    expect(
      inspectExplorationWorld({
        playerId: createPlayerId(),
        location: location(),
        publishedAreas: published(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    for (const publishedAreas of [
      null,
      { ...published(), contentReleaseId: "different-release" },
    ]) {
      expect(
        inspectExplorationWorld({ playerId, location: location(), publishedAreas }),
      ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    }
  });

  it("rejects relocation, unapproved authored areas and missing encounter tables", () => {
    const original = location();
    for (const candidate of [
      { ...original, requiresRelocation: true },
      { ...original, areaSlug: "unreleased-route" },
      { ...original, regionSlug: "another-region" },
    ]) {
      expect(
        inspectExplorationWorld({
          playerId,
          location: candidate,
          publishedAreas: published(),
        }),
      ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    }
    expect(
      inspectExplorationWorld({
        playerId,
        location: original,
        publishedAreas: { ...published(), encounterReadyAreaIds: [yunId] },
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("never offers blocked, unpublished, unconnected or unrelated destinations", () => {
    const original = location();
    const locationWithExtras: WorldLocationView = {
      ...original,
      connections: [
        ...original.connections,
        {
          connectionId: "locked",
          connectionKey: "locked-yun",
          destinationAreaId: yunId,
          destinationSlug: "campos-de-yun",
          destinationDisplayName: "Campos de Yun",
          available: false,
          missingUnlockKeys: ["story.unlock"],
        },
        {
          connectionId: "not-launched",
          connectionKey: "other",
          destinationAreaId: "area-other",
          destinationSlug: "other-zhoulia-area",
          destinationDisplayName: "Outro lugar",
          available: true,
          missingUnlockKeys: [],
        },
        {
          connectionId: "not-published",
          connectionKey: "hidden",
          destinationAreaId: "another-area",
          destinationSlug: "campos-de-yun",
          destinationDisplayName: "Campos de Yun",
          available: true,
          missingUnlockKeys: [],
        },
      ],
    };
    expect(
      inspectExplorationWorld({
        playerId,
        location: locationWithExtras,
        publishedAreas: published(),
      }),
    ).toMatchObject({
      ok: true,
      value: { availableDestinations: [{ connectionId: "route-yun" }] },
    });

    expect(
      inspectExplorationWorld({
        playerId,
        location: locationWithExtras,
        publishedAreas: { ...published(), encounterReadyAreaIds: [villageId] },
      }),
    ).toMatchObject({ ok: true, value: { availableDestinations: [] } });
  });

  it("supports the published Yun area without assuming a route or inventing travel minutes", () => {
    const current = {
      ...location(),
      areaId: yunId,
      areaSlug: "campos-de-yun",
      connections: [],
    };
    const result = inspectExplorationWorld({
      playerId,
      location: current,
      publishedAreas: published(),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { currentAreaId: yunId, availableDestinations: [] },
    });
  });
});
