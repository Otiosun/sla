import { describe, expect, it } from "vitest";
import { parseCombatSceneMessage } from "../../src/modules/battle/combat-scene-message.js";

const prose = (n: number) => Array.from({ length: n }, () => "árvore").join(" ");
describe("authored combat Cena parsing", () => {
  it.each([49, 50, 51])("counts %i narrative words without command parameters", (count) => {
    for (const text of [
      `/movimento 2 ${prose(count)}`,
      `${prose(20)} /movimento 2 ${prose(count - 20)}`,
      `${prose(count)} /movimento 2`,
    ]) {
      expect(parseCombatSceneMessage(text)).toMatchObject({
        ok: true,
        value: { command: "/movimento 2", wordCount: count },
      });
    }
  });
  it("counts Unicode and excludes URLs, code, quotes, mentions and pure numbers", () => {
    const text =
      "/cena ação coração mãe d'água guarda-chuva 123 👾 @jogador https://example.com/palavras extras\n> texto citado ignorado\n```\ncinquenta palavras de código\n```\n`não conta`";
    expect(parseCombatSceneMessage(text)).toMatchObject({
      ok: true,
      value: { wordCount: 6, explicitScene: true, command: null },
    });
  });
  it("does not treat quoted/code commands as authorizations", () => {
    expect(
      parseCombatSceneMessage("> /movimento 2\n```/capturar Poké Ball```\n/cena " + prose(50)),
    ).toMatchObject({ ok: true, value: { command: null, wordCount: 50 } });
  });
  it.each(["2e0", "0x2", "2.5", "2abc", "0", "-2", "7", "999999999999999999999"])(
    "rejects malformed slot %s",
    (token) => {
      expect(parseCombatSceneMessage(`/trocar ${token} ${prose(50)}`).ok).toBe(false);
    },
  );
  it("accepts a bare capture directive separated from narrative by a newline", () => {
    expect(
      parseCombatSceneMessage("/capturar\n" + prose(50), { capturar: ["Poké Ball"] }),
    ).toMatchObject({ ok: true, value: { command: "/capturar", wordCount: 50 } });
  });
  it("matches catalog names with multiple words without counting their parameters", () => {
    expect(
      parseCombatSceneMessage(`/capturar Poké Ball ${prose(50)}`, {
        capturar: ["Poké Ball", "Great Ball"],
      }),
    ).toMatchObject({ ok: true, value: { command: "/capturar Poké Ball", wordCount: 50 } });
    expect(
      parseCombatSceneMessage(`${prose(25)} /movimento Quick Attack ${prose(25)}`, {
        movimento: ["Quick Attack"],
      }),
    ).toMatchObject({ ok: true, value: { command: "/movimento Quick Attack", wordCount: 50 } });
    expect(
      parseCombatSceneMessage("/capturar Inventada " + prose(50), { capturar: ["Poké Ball"] }).ok,
    ).toBe(false);
  });
  it("rejects multiple mechanical directives or repeated markers", () => {
    for (const text of [
      "/movimento 1 /trocar 2",
      "/cena /cena " + prose(50),
      "/item Potion " + prose(50),
    ])
      expect(parseCombatSceneMessage(text).ok).toBe(false);
  });
});
