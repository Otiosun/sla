import { describe, expect, it } from "vitest";
import {
  renderEditSelect,
  renderFullForm,
  renderGuidedAcknowledgement,
  renderGuidedField,
  renderModeSelect,
  renderPause,
  renderRestartConfirm,
  renderResumeMenu,
  renderReview,
  renderStarterOptions,
  renderValidationRetry,
} from "../../src/modules/registration/conversation-renderer.js";

const starterOptions = ["Charmander", "Squirtle", "Bulbasaur"] as const;

describe("registration conversation renderer", () => {
  it("renders a self-guiding mode choice", () => {
    const text = renderModeSelect();

    expect(text).toContain("`01`");
    expect(text).toContain("`02`");
    expect(text.toLocaleLowerCase("pt-BR")).toContain("responda com");
  });

  it("renders every guided field with explicit 1/7 through 7/7 progress", () => {
    const cases = [
      ["trainerName", "01 / 07", "𝗡𝗢𝗠𝗘 𝗗𝗢 𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥"],
      ["age", "02 / 07", "𝗜𝗗𝗔𝗗𝗘"],
      ["genderPronouns", "03 / 07", "𝗚Ê𝗡𝗘𝗥𝗢 & 𝗣𝗥𝗢𝗡𝗢𝗠𝗘𝗦"],
      ["appearance", "04 / 07", "𝗔𝗣𝗔𝗥Ê𝗡𝗖𝗜𝗔"],
      ["personality", "05 / 07", "𝗣𝗘𝗥𝗦𝗢𝗡𝗔𝗟𝗜𝗗𝗔𝗗𝗘"],
      ["backstory", "06 / 07", "𝗛𝗜𝗦𝗧Ó𝗥𝗜𝗔"],
      ["starterFormId", "07 / 07", "𝗣𝗢𝗞É𝗠𝗢𝗡 𝗜𝗡𝗜𝗖𝗜𝗔𝗟"],
    ] as const;

    for (const [field, progress, label] of cases) {
      const text = renderGuidedField(field, { starterOptions });
      expect(text).toContain(progress);
      expect(text).toContain(label);
      expect(text.toLocaleLowerCase("pt-BR")).toContain("envie a ficha preenchida");
    }
  });

  it("acknowledges guided mode selection before the first question", () => {
    const text = renderGuidedField("trainerName", { starterOptions, modeSelected: true });

    expect(text).toContain("✓ *Modo passo a passo escolhido.*");
    expect(text).toContain("01 / 07");
    expect(text).toContain("𝗡𝗢𝗠𝗘 𝗗𝗢 𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥");
  });

  it("echoes short answers but does not repeat long narrative fields", () => {
    expect(renderGuidedAcknowledgement("trainerName", "Killian")).toBe(
      "✓ *Nome registrado:* Killian",
    );
    expect(renderGuidedAcknowledgement("age", 19)).toBe("✓ *Idade registrada:* 19");
    expect(renderGuidedAcknowledgement("starterFormId", "Charmander")).toBe(
      "✓ *Pokémon inicial registrado:* Charmander",
    );

    const longAppearance = "Uma descrição de aparência que não deve ser ecoada inteira.";
    expect(renderGuidedAcknowledgement("appearance", longAppearance)).toBe(
      "✓ *Aparência registrada.*",
    );
    expect(renderGuidedAcknowledgement("personality", "Texto longo")).toBe(
      "✓ *Personalidade registrada.*",
    );
    expect(renderGuidedAcknowledgement("backstory", "Texto longo")).toBe(
      "✓ *História registrada.*",
    );
  });

  it("renders canonical starters as their own reusable message", () => {
    const text = renderStarterOptions(starterOptions);

    expect(text).toContain("𝗣𝗢𝗞É𝗠𝗢𝗡 𝗜𝗡𝗜𝗖𝗜𝗔𝗜𝗦");
    expect(text).toContain("`01` Charmander");
    expect(text).toContain("`02` Squirtle");
    expect(text).toContain("`03` Bulbasaur");
    expect(text).toContain("/iniciais");
  });
  it("confirms full-form mode and includes current starter options plus the complete template", () => {
    const text = renderFullForm({ regionDisplayName: "Zhoulia", starterOptions });

    expect(text).toContain("▣ *𝗙𝗜𝗖𝗛𝗔 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗔*");
    expect(text).toContain("Nome:");
    expect(text).toContain("Idade:");
    expect(text).toContain("Gênero / pronomes:");
    expect(text).toContain("Aparência:");
    expect(text).toContain("Personalidade:");
    expect(text).toContain("História / resumo:");
    expect(text).toContain("Pokémon inicial:");
    expect(text).toContain("Zhoulia");
    expect(text.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");
  });

  it("renders review without internal ids and ends with the three canonical actions", () => {
    const text = renderReview({
      trainerName: "Killian",
      age: 19,
      genderPronouns: "masculino / ele",
      appearance: "Cabelo preto.",
      personality: "Reservado.",
      backstory: "Primeira linha.\nSegunda linha.",
      starterDisplayName: "Charmander",
      regionDisplayName: "Zhoulia",
    });

    expect(text).toContain("▣ *𝗥𝗘𝗩𝗜𝗦Ã𝗢 𝗗𝗢 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢*");
    expect(text).toContain("*Nome:* Killian");
    expect(text).toContain("*Pokémon inicial:* Charmander");
    expect(text).toContain("*Região:* Zhoulia");
    expect(text.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(
      text.includes("`01` Enviar para análise\n`02` Corrigir informações\n`03` Continuar depois"),
    ).toBe(true);
  });

  it("renders edit, pause, resume and destructive restart choices explicitly", () => {
    const edit = renderEditSelect();
    expect(edit).toContain("✎ *𝗖𝗢𝗥𝗥𝗜𝗚𝗜𝗥 𝗙𝗜𝗖𝗛𝗔*");
    expect(edit).toContain("`01` Nome");
    expect(edit).toContain("`08` Voltar");
    expect(edit.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");

    expect(renderPause()).toContain("💾 Seu progresso está salvo.");
    expect(renderPause()).toContain("/registrar");

    const resume = renderResumeMenu();
    expect(resume).toContain("`01` Continuar de onde parei");
    expect(resume).toContain("`02` Ver ficha atual");
    expect(resume).toContain("`03` Recomeçar");
    expect(resume.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");

    const restart = renderRestartConfirm();
    expect(restart).toContain("⚠️ Recomeçar apaga o rascunho atual.");
    expect(restart).toContain("`01` Sim, recomeçar");
    expect(restart).toContain("`02` Cancelar");
    expect(restart.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");
  });

  it("renders contextual validation retry without support or correlation codes", () => {
    const text = renderValidationRetry(
      "Essa idade não é válida. Envie apenas um número inteiro maior que 0.",
      renderGuidedField("age", { starterOptions }),
    );

    expect(text).toContain("△ *Essa idade não é válida.");
    expect(text).toContain("02 / 07");
    expect(text.toLocaleLowerCase("pt-BR")).not.toContain("correlation");
    expect(text.toLocaleLowerCase("pt-BR")).not.toContain("suporte:");
  });
});
