import { describe, expect, it } from "vitest";
import {
  EXPEDITION_ACTION_MINUTES,
  EXPEDITION_DURATION_MINUTES,
  EXPEDITION_WEEKLY_LIMIT,
  expeditionClock,
} from "../../src/modules/exploration/expedition-clock.js";

describe("solo expedition action-driven clock", () => {
  it("runs the daytime expedition from 06:00 to 18:00", () => {
    expect(expeditionClock("DAY", 0)).toEqual({
      period: "DAY",
      elapsedMinutes: 0,
      remainingMinutes: 720,
      currentTime: "06:00",
      endTime: "18:00",
      completed: false,
    });
    expect(expeditionClock("DAY", 75).currentTime).toBe("07:15");
    expect(expeditionClock("DAY", 720)).toMatchObject({
      currentTime: "18:00",
      remainingMinutes: 0,
      completed: true,
    });
  });

  it("crosses midnight and ends the night expedition at 06:00", () => {
    expect(expeditionClock("NIGHT", 0).currentTime).toBe("18:00");
    expect(expeditionClock("NIGHT", 360).currentTime).toBe("00:00");
    expect(expeditionClock("NIGHT", 719).currentTime).toBe("05:59");
    expect(expeditionClock("NIGHT", 720)).toMatchObject({
      currentTime: "06:00",
      endTime: "06:00",
      completed: true,
    });
  });

  it("only changes when the caller supplies elapsed action minutes", () => {
    const before = expeditionClock("DAY", 30);
    expect(expeditionClock("DAY", 30)).toEqual(before);
    expect(expeditionClock("DAY", 30 + EXPEDITION_ACTION_MINUTES.FOLLOW_TRACKS).currentTime).toBe(
      "06:45",
    );
  });

  it("exposes only the approved V1 baseline action costs", () => {
    expect(EXPEDITION_WEEKLY_LIMIT).toBe(3);
    expect(EXPEDITION_DURATION_MINUTES).toBe(720);
    expect(EXPEDITION_ACTION_MINUTES).toEqual({
      SEARCH_POKEMON: 30,
      FOLLOW_TRACKS: 15,
      IGNORE_INCIDENTAL: 10,
      FINISH_BATTLE: 30,
      SEARCH_RESOURCES: 60,
      USE_POKEMON_CENTER: 30,
      VIEW_TEAM: 0,
      VIEW_INVENTORY: 0,
      CONSULT_ROTOMDEX: 0,
      USE_POKEMART: 0,
    });
  });

  it("rejects invalid duration instead of wrapping into another day", () => {
    for (const value of [-1, 721, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => expeditionClock("DAY", value)).toThrow(RangeError);
    }
  });
});
