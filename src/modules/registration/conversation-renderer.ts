import type { RegistrationConversationField } from "./conversation-session.js";

export interface RegistrationGuidedRenderOptions {
  readonly starterOptions?: readonly string[];
  readonly modeSelected?: boolean;
}

export interface RegistrationFullFormRenderOptions {
  readonly regionDisplayName: string;
  readonly starterOptions: readonly string[];
}

export interface RegistrationReviewRenderInput {
  readonly trainerName: string;
  readonly age: number;
  readonly genderPronouns: string;
  readonly appearance: string;
  readonly personality: string;
  readonly backstory: string;
  readonly starterDisplayName: string;
  readonly regionDisplayName: string;
}

const FIELD_COPY: Readonly<
  Record<
    RegistrationConversationField,
    {
      readonly progress: string;
      readonly label: string;
      readonly question: string;
    }
  >
> = {
  trainerName: {
    progress: "1/7",
    label: "Nome do treinador",
    question: "Qual será o nome do personagem?",
  },
  age: {
    progress: "2/7",
    label: "Idade",
    question: "Qual é a idade do personagem?",
  },
  genderPronouns: {
    progress: "3/7",
    label: "Gênero / pronomes",
    question: "Como quer registrar esse campo?",
  },
  appearance: {
    progress: "4/7",
    label: "Aparência",
    question: "Descreva a aparência do personagem.",
  },
  personality: {
    progress: "5/7",
    label: "Personalidade",
    question: "Descreva a personalidade do personagem.",
  },
  backstory: {
    progress: "6/7",
    label: "História / resumo",
    question: "Conte a história ou um resumo do personagem.",
  },
  starterFormId: {
    progress: "7/7",
    label: "Pokémon inicial",
    question: "Escolha pelo número ou pelo nome.",
  },
};

function numberedOptions(options: readonly string[]): string {
  return options.map((option, index) => `${index + 1}. ${option}`).join("\n");
}

export function renderModeSelect(): string {
  return [
    "🎒 Vamos montar sua ficha.",
    "",
    "Escolha como prefere preencher:",
    "",
    "1 — Modo guiado, passo a passo",
    "2 — Ficha completa de uma vez",
    "",
    "Responda a esta mensagem com 1 ou 2.",
  ].join("\n");
}

export function renderGuidedField(
  field: RegistrationConversationField,
  options: RegistrationGuidedRenderOptions = {},
): string {
  const copy = FIELD_COPY[field];
  const prompt =
    field === "starterFormId"
      ? [
          `📝 ${copy.progress} — ${copy.label}`,
          "",
          numberedOptions(options.starterOptions ?? []),
          "",
          copy.question,
          "",
          "Responda a esta mensagem.",
        ]
          .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
          .join("\n")
          .trim()
      : [
          `📝 ${copy.progress} — ${copy.label}`,
          copy.question,
          "",
          "Responda a esta mensagem.",
        ].join("\n");

  if (!options.modeSelected) return prompt;

  return [
    "✅ Modo guiado escolhido.",
    "Vamos fazer em 7 etapas. Nada será enviado sem sua confirmação.",
    "",
    prompt,
  ].join("\n");
}

export function renderGuidedAcknowledgement(
  field: RegistrationConversationField,
  value: string | number,
): string {
  switch (field) {
    case "trainerName":
      return `✅ 1/7 — Nome: ${String(value).trim()}`;
    case "age":
      return `✅ 2/7 — Idade: ${String(value).trim()}`;
    case "genderPronouns":
      return `✅ 3/7 — Gênero / pronomes: ${String(value).trim()}`;
    case "appearance":
      return "✅ Aparência recebida.";
    case "personality":
      return "✅ Personalidade recebida.";
    case "backstory":
      return "✅ História recebida.";
    case "starterFormId":
      return `✅ 7/7 — Pokémon inicial: ${String(value).trim()}`;
  }
}

export function renderFullForm(options: RegistrationFullFormRenderOptions): string {
  return [
    "✅ Modo ficha completa escolhido.",
    "",
    "📋 FICHA COMPLETA",
    "",
    "Pokémon iniciais disponíveis:",
    numberedOptions(options.starterOptions),
    "",
    "Preencha o modelo abaixo e envie respondendo a esta mensagem:",
    "",
    "Nome:",
    "Idade:",
    "Gênero / pronomes:",
    "Aparência:",
    "Personalidade:",
    "História / resumo:",
    "Pokémon inicial:",
    "",
    `Região: ${options.regionDisplayName} — preenchida automaticamente.`,
    "Nada será enviado para análise sem sua confirmação.",
  ].join("\n");
}

export function renderReview(input: RegistrationReviewRenderInput): string {
  return [
    "📋 FICHA PRONTA PARA REVISÃO",
    "",
    `Nome: ${input.trainerName}`,
    `Idade: ${input.age}`,
    `Gênero / pronomes: ${input.genderPronouns}`,
    `Aparência: ${input.appearance}`,
    `Personalidade: ${input.personality}`,
    `História / resumo: ${input.backstory}`,
    `Pokémon inicial: ${input.starterDisplayName}`,
    `Região: ${input.regionDisplayName}`,
    "",
    "1 — Enviar para análise",
    "2 — Corrigir alguma informação",
    "3 — Continuar depois",
  ].join("\n");
}

export function renderEditSelect(): string {
  return [
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
  ].join("\n");
}

export function renderPause(): string {
  return ["💾 Seu progresso está salvo.", "Quando quiser continuar, use `$registrar`."].join("\n");
}

export function renderResumeMenu(): string {
  return [
    "🎒 Você já tem uma ficha em andamento.",
    "",
    "1 — Continuar de onde parei",
    "2 — Ver ficha atual",
    "3 — Recomeçar",
  ].join("\n");
}

export function renderRestartConfirm(): string {
  return ["⚠️ Recomeçar apaga o rascunho atual.", "", "1 — Sim, recomeçar", "2 — Cancelar"].join(
    "\n",
  );
}

export function renderValidationRetry(message: string, prompt: string): string {
  return [`⚠️ ${message.trim()}`, "", prompt.trim()].join("\n");
}
