import { describe, expect, it } from "vitest";
import { parseFullRegistrationTemplate } from "../../src/modules/registration/conversation-session.js";

const SQUIRTLE_ID = "33333333-3333-4333-8333-333333333333";

describe("full registration multiline paragraphs", () => {
  it("preserves one interior blank line while trimming leading, repeated and trailing blanks", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "Nome: Liora Vale",
        "Idade: 17",
        "Pronomes: ela/dela",
        "Aparência:",
        "",
        "Cabelos negros.",
        "",
        "",
        "Usa um casaco de viagem.",
        "",
        "Personalidade: Curiosa e competitiva.",
        "História:",
        "Primeiro parágrafo.",
        "",
        "Segundo parágrafo.",
        "",
        `Inicial: ${SQUIRTLE_ID}`,
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        appearance: "Cabelos negros.\n\nUsa um casaco de viagem.",
        backstory: "Primeiro parágrafo.\n\nSegundo parágrafo.",
      },
    });
  });

  it("keeps unknown label-like lines as content instead of redirecting the parser", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "Nome: Liora Vale",
        "Idade: 17",
        "Pronomes: ela/dela",
        "Aparência: Cabelos negros.",
        "Detalhes: usa um casaco de viagem.",
        "Personalidade: Curiosa.",
        "História: Saiu de casa para pesquisar Pokémon raros.",
        `Inicial: ${SQUIRTLE_ID}`,
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { appearance: "Cabelos negros.\nDetalhes: usa um casaco de viagem." },
    });
  });
});
