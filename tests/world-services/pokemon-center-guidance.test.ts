import { describe, expect, it } from "vitest";
import {
  renderCenterHanaContinuation,
  renderCenterHanaConversation,
  renderWorldServiceEntry,
} from "../../src/modules/world-services/renderer.js";

describe("Centro Pokémon: discoverable services without command memorization", () => {
  it("presents the active mechanical services from reception", () => {
    const center = renderWorldServiceEntry("POKEMON_CENTER");
    expect(center).toContain("/curar");
    expect(center).toContain("/pc");
    expect(center).toContain("/reaprender #1");
    expect(center).toContain("/conversar");
    expect(center).toContain("/sair");
  });

  it("Hana teaches how to recover eligible previous moves from normal player dialogue", () => {
    const initial = renderCenterHanaConversation();
    expect(initial).toContain("/reaprender #1");
    const guided = renderCenterHanaContinuation("Como reaprender golpes que esqueci?");
    expect(guided).toContain("/reaprender #1");
    expect(guided).toContain("/aprendizados #1");
    expect(guided).toContain("quatro slots");
  });

  it("does not confuse healing and PC storage with move reminding", () => {
    const heal = renderCenterHanaContinuation("meu Pokémon está ferido");
    expect(heal).toContain("/curar");
    const storage = renderCenterHanaContinuation("onde ficam as caixas?");
    expect(storage).toContain("/pc");
  });
});
