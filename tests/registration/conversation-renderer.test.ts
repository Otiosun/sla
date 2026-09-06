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
  renderValidationRetry,
} from "../../src/modules/registration/conversation-renderer.js";

const starterOptions = ["Charmander", "Squirtle", "Bulbasaur"] as const;

describe("registration conversation renderer", () => {
  it("renders a self-guiding mode choice", () => {
    const text = renderModeSelect();

    expect(text).toContain("1 —");
    expect(text).toContain("2 —");
    expect(text.toLocaleLowerCase("pt-BR")).toContain("responda a esta mensagem");
  });

  it("renders every guided field with explicit 1/7 through 7/7 progress", () => {
    const cases = [
      ["trainerName", "1/7", "Nome do treinador"],
      ["age", "2/7", "Idade"],
      ["genderPronouns", "3/7", "Gênero / pronomes"],
      ["appearance", "4/7", "Aparência"],
      ["personality", "5/7", "Personalidade"],
      ["backstory", "6/7", "História / resumo"],
      ["starterFormId", "7/7", "Pokémon inicial"],
    ] as const;

    for (const [field, progress, label] of cases) {
      const text = renderGuidedField(field, { starterOptions });
      expect(text).toContain(progress);
      expect(text).toContain(label);
    }
  });

  it("acknowledges guided mode selection before the first question", () => {
    const text = renderGuidedField("trainerName", { starterOptions, modeSelected: true });

    expect(text).toContain("✅ Modo guiado escolhido.");
    expect(text).toContain("7 etapas");
    expect(text).toContain("📝 1/7 — Nome do treinador");
  });

  it("echoes short answers but does not repeat long narrative fields", () => {
    expect(renderGuidedAcknowledgement("trainerName", "Killian")).toBe(
      "✅ 1/7 — Nome: Killian",
    );
    expect(renderGuidedAcknowledgement("age", 19)).toBe("✅ 2/7 — Idade: 19");
    expect(renderGuidedAcknowledgement("starterFormId", "Charmander")).toBe(
      "✅ 7/7 — Pokémon inicial: Charmander",
    );

    const longAppearance = "Uma descrição de aparência que não deve ser ecoada inteira.";
    expect(renderGuidedAcknowledgement("appearance", longAppearance)).toBe(
      "✅ Aparência recebida.",
    );
    expect(renderGuidedAcknowledgement("personality", "Texto longo")).toBe(
      "✅ Personalidade recebida.",
    );
    expect(renderGuidedAcknowledgement("backstory", "Texto longo")).toBe(
      "✅ História recebida.",
    );
  });

  it("confirms full-form mode and includes current starter options plus the complete template", () => {
    const text = renderFullForm({ regionDisplayName: "Zhoulia", starterOptions });

    expect(text).toContain("✅ Modo ficha completa escolhido.");
    expect(text).toContain("Charmander");
    expect(text).toContain("Squirtle");
    expect(text).toContain("Bulbasaur");
    expect(text).toContain("Nome:");
    expect(text).toContain("Idade:");
    expect(text).toContain("Gênero / pronomes:");
    expect(text).toContain("Aparência:");
    expect(text).toContain("Personalidade:");
    expect(text).toContain("História / resumo:");
    expect(text).toContain("Pokémon inicial:");
    expect(text).toContain("Zhoulia");
    expect(text.toLocaleLowerCase("pt-BR")).toContain("respondendo a esta mensagem");
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

    expect(text).toContain("📋 FICHA PRONTA PARA REVISÃO");
    expect(text).toContain("Nome: Killian");
    expect(text).toContain("Pokémon inicial: Charmander");
    expect(text).toContain("Região: Zhoulia");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(text.endsWith("1 — Enviar para análise\n2 — Corrigir alguma informação\n3 — Continuar depois")).toBe(
      true,
    );
  });

  it("renders edit, pause, resume and destructive restart choices explicitly", () => {
    expect(renderEditSelect()).toBe(
      [
        "✏️ O que deseja corrigir?",
        "",
        "1 — Nome",
        "2 — Idade",
        "3 — Gênero / pronomes",
        "4 — Aparência",
        "5 — Personalidade",
        "6 — História / resumo",
        "7 — Pokémon inicial",
        "8 — Voltar",
      ].join("\n"),
    );
    expect(renderPause()).toContain("💾 Seu progresso está salvo.");
    expect(renderPause()).toContain("$registrar");
    expect(renderResumeMenu()).toContain("1 — Continuar de onde parei");
    expect(renderResumeMenu()).toContain("2 — Ver ficha atual");
    expect(renderResumeMenu()).toContain("3 — Recomeçar");
    expect(renderRestartConfirm()).toContain("⚠️ Recomeçar apaga o rascunho atual.");
    expect(renderRestartConfirm()).toContain("1 — Sim, recomeçar");
    expect(renderRestartConfirm()).toContain("2 — Cancelar");
  });

  it("renders contextual validation retry without support or correlation codes", () => {
    const text = renderValidationRetry(
      "Essa idade não é válida. Envie apenas um número inteiro maior que 0.",
      renderGuidedField("age", { starterOptions }),
    );

    expect(text).toContain("⚠️ Essa idade não é válida.");
    expect(text).toContain("📝 2/7 — Idade");
    expect(text.toLocaleLowerCase("pt-BR")).not.toContain("correlation");
    expect(text.toLocaleLowerCase("pt-BR")).not.toContain("suporte:");
  });
});
