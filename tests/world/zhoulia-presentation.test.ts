import { describe, expect, it } from "vitest";
import {
  VILA_DOS_ARROZAIS_FIRST_ARRIVAL,
  VILA_DOS_ARROZAIS_RETURN,
  zhouliaArrivalCaption,
} from "../../src/modules/world/zhoulia-presentation.js";

describe("Zhoulia Vila dos Arrozais presentation", () => {
  it("keeps the canonical first-arrival presentation concise and narrative", () => {
    expect(zhouliaArrivalCaption("vila-dos-arrozais", true)).toBe(VILA_DOS_ARROZAIS_FIRST_ARRIVAL);
    expect(VILA_DOS_ARROZAIS_FIRST_ARRIVAL).toContain("VOCÊ CHEGOU — VILA DOS ARROZAIS");
  });

  it("uses the compact return presentation only for a later visit", () => {
    expect(zhouliaArrivalCaption("vila-dos-arrozais", false)).toBe(VILA_DOS_ARROZAIS_RETURN);
    expect(VILA_DOS_ARROZAIS_RETURN).toContain("VOCÊ RETORNOU — VILA DOS ARROZAIS");
  });

  it("does not invent presentation content for future Zhoulia areas", () => {
    expect(zhouliaArrivalCaption("campos-de-yun", true)).toBeNull();
  });
});
