import {
  trainerProfessionDisplayName,
  type TrainerProfessionSelection,
} from "../player/professions.js";
import type { RegistrationConversationField } from "./conversation-session.js";

export interface RegistrationGuidedRenderOptions {
  readonly starterOptions?: readonly string[];
  readonly modeSelected?: boolean;
}

export interface RegistrationEditFieldRenderOptions {
  readonly starterOptions?: readonly string[];
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
  readonly profession?: TrainerProfessionSelection;
  readonly starterDisplayName: string;
  readonly regionDisplayName: string;
}

export interface RegistrationDraftProgressRenderInput {
  readonly trainerName?: string;
  readonly age?: number;
  readonly genderPronouns?: string;
  readonly appearance?: string;
  readonly personality?: string;
  readonly backstory?: string;
  readonly profession?: TrainerProfessionSelection;
  readonly starterDisplayName?: string;
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
    progress: "1/8",
    label: "Nome do treinador",
    question: "Qual será o nome do personagem?",
  },
  age: {
    progress: "2/8",
    label: "Idade",
    question: "Qual é a idade do personagem?",
  },
  genderPronouns: {
    progress: "3/8",
    label: "Gênero / pronomes",
    question: "Como quer registrar esse campo?",
  },
  appearance: {
    progress: "4/8",
    label: "Aparência",
    question: "Descreva a aparência do personagem, se quiser.",
  },
  personality: {
    progress: "5/8",
    label: "Personalidade",
    question: "Descreva a personalidade do personagem.",
  },
  backstory: {
    progress: "6/8",
    label: "História / resumo",
    question: "Conte a história ou um resumo do personagem, se quiser.",
  },
  profession: {
    progress: "7/8",
    label: "Profissão",
    question: "Qual é a profissão do personagem?",
  },
  starterFormId: {
    progress: "8/8",
    label: "Pokémon inicial",
    question: "Escolha pelo número ou pelo nome.",
  },
};

function numberedOptions(options: readonly string[]): string {
  return options
    .map((option, index) => `\`${String(index + 1).padStart(2, "0")}\` ${option}`)
    .join("\n");
}

function draftValue(value: string | number | undefined): string {
  if (value === undefined || String(value).trim().length === 0) return "—";
  return String(value).trim();
}

function fieldHeading(field: RegistrationConversationField): string {
  switch (field) {
    case "trainerName":
      return "◇ *𝗡𝗢𝗠𝗘 𝗗𝗢 𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥*";
    case "age":
      return "◇ *𝗜𝗗𝗔𝗗𝗘*";
    case "genderPronouns":
      return "◇ *𝗚Ê𝗡𝗘𝗥𝗢 & 𝗣𝗥𝗢𝗡𝗢𝗠𝗘𝗦*";
    case "appearance":
      return "◇ *𝗔𝗣𝗔𝗥Ê𝗡𝗖𝗜𝗔*";
    case "personality":
      return "◇ *𝗣𝗘𝗥𝗦𝗢𝗡𝗔𝗟𝗜𝗗𝗔𝗗𝗘*";
    case "backstory":
      return "◇ *𝗛𝗜𝗦𝗧Ó𝗥𝗜𝗔*";
    case "profession":
      return "◇ *𝗣𝗥𝗢𝗙𝗜𝗦𝗦Ã𝗢*";
    case "starterFormId":
      return "✦ *𝗣𝗢𝗞É𝗠𝗢𝗡 𝗜𝗡𝗜𝗖𝗜𝗔𝗟*";
  }
}

function fieldInstruction(field: RegistrationConversationField): string {
  switch (field) {
    case "trainerName":
      return "› _Responda normalmente._";
    case "age":
      return "› _Responda apenas com a idade._";
    case "genderPronouns":
      return "› _Ex.: feminino · ela/dela_";
    case "appearance":
      return "> _Opcional. Pode escrever livremente ou responder `pular`._";
    case "personality":
      return "> _Escreva do seu jeito._";
    case "backstory":
      return "> _Opcional. Pode escrever normalmente ou responder `pular`._";
    case "profession":
      return "› _Responda com o nome da profissão escolhida._";
    case "starterFormId":
      return "› _Responda com o número ou o nome do Pokémon._";
  }
}

export function renderModeSelect(): string {
  return [
    "⚡ *𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢 𝗗𝗘 𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥*",
    "　Recepção · Novo treinador",
    "",
    "> _Antes de começar sua jornada por Zhoulia, precisamos registrar quem você será por aqui._",
    "",
    "◇ *𝗖𝗢𝗠𝗢 𝗣𝗥𝗘𝗙𝗘𝗥𝗘 𝗖𝗥𝗜𝗔𝗥?*",
    "",
    "`01` Passo a passo",
    "　Uma informação por vez.",
    "",
    "`02` Ficha completa",
    "　Preencha tudo de uma só vez.",
    "",
    "› _Responda com `01` ou `02`._",
  ].join("\n");
}

export function renderStarterOptions(starterOptions: readonly string[]): string {
  return [
    "✦ *𝗣𝗢𝗞É𝗠𝗢𝗡 𝗜𝗡𝗜𝗖𝗜𝗔𝗜𝗦*",
    "　Zhoulia · Disponíveis",
    "",
    numberedOptions(starterOptions),
    "",
    "› _Durante o registro, você pode escolher pelo número ou pelo nome._",
    "› _Se precisar rever esta lista, use `/iniciais`._",
  ].join("\n");
}

export function renderGuidedField(
  field: RegistrationConversationField,
  options: RegistrationGuidedRenderOptions = {},
): string {
  const copy = FIELD_COPY[field];
  const lines = [
    fieldHeading(field),
    `　Registro · \`${copy.progress.split("/")[0]?.padStart(2, "0")} / ${copy.progress.split("/")[1]?.padStart(2, "0")}\``,
    "",
  ];

  if (field === "profession") {
    lines.push(
      "Escolha a profissão do personagem:",
      "",
      "› _Veja as profissões e os detalhes no site:_",
      "https://pokemon-hub-web-self.vercel.app/sistemas/profissoes",
      "",
      fieldInstruction(field),
    );
  } else if (field === "starterFormId") {
    lines.push(
      "Escolha um dos Pokémon disponíveis:",
      "",
      numberedOptions(options.starterOptions ?? []),
      "",
      fieldInstruction(field),
      "",
      "› _Esqueceu as opções? Use `/iniciais`._",
    );
  } else {
    lines.push(copy.question, "", fieldInstruction(field));
  }

  if (!options.modeSelected) return lines.join("\n");

  return ["✓ *Modo passo a passo escolhido.*", "", ...lines].join("\n");
}

export function renderGuidedAcknowledgement(
  field: RegistrationConversationField,
  value: string | number,
): string {
  switch (field) {
    case "trainerName":
      return `✓ *Nome registrado:* ${String(value).trim()}`;
    case "age":
      return `✓ *Idade registrada:* ${String(value).trim()}`;
    case "genderPronouns":
      return `✓ *Gênero / pronomes registrados:* ${String(value).trim()}`;
    case "appearance":
      return "✓ *Aparência registrada.*";
    case "personality":
      return "✓ *Personalidade registrada.*";
    case "backstory":
      return "✓ *História registrada.*";
    case "profession":
      return `✓ *Profissão registrada:* ${trainerProfessionDisplayName(String(value) as TrainerProfessionSelection)}`;
    case "starterFormId":
      return `✓ *Pokémon inicial registrado:* ${String(value).trim()}`;
  }
}

export function renderEditField(
  field: RegistrationConversationField,
  options: RegistrationEditFieldRenderOptions = {},
): string {
  const copy = FIELD_COPY[field];
  const lines = ["✎ *𝗖𝗢𝗥𝗥𝗜𝗚𝗜𝗥 𝗙𝗜𝗖𝗛𝗔*", `　${copy.label}`, ""];
  if (field === "profession") {
    lines.push(
      "› _Veja as profissões e os detalhes no site:_",
      "https://pokemon-hub-web-self.vercel.app/sistemas/profissoes",
      "",
      "› _Envie o nome da nova profissão._",
    );
  } else if (field === "starterFormId") {
    lines.push(numberedOptions(options.starterOptions ?? []), "", "› _Número ou nome do Pokémon._");
  } else {
    lines.push(copy.question, "", "› _Envie o novo valor respondendo a esta mensagem._");
  }
  return lines.join("\n");
}

export function renderEditAcknowledgement(
  field: RegistrationConversationField,
  value: string | number,
): string {
  switch (field) {
    case "trainerName":
      return `✓ *Nome atualizado:* ${String(value).trim()}`;
    case "age":
      return `✓ *Idade atualizada:* ${String(value).trim()}`;
    case "genderPronouns":
      return `✓ *Gênero / pronomes atualizados:* ${String(value).trim()}`;
    case "appearance":
      return "✓ *Aparência atualizada.*";
    case "personality":
      return "✓ *Personalidade atualizada.*";
    case "backstory":
      return "✓ *História atualizada.*";
    case "profession":
      return `✓ *Profissão atualizada:* ${trainerProfessionDisplayName(String(value) as TrainerProfessionSelection)}`;
    case "starterFormId":
      return `✓ *Pokémon inicial atualizado:* ${String(value).trim()}`;
  }
}

export function renderFullForm(options: RegistrationFullFormRenderOptions): string {
  return [
    "▣ *𝗙𝗜𝗖𝗛𝗔 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗔*",
    "　Recepção · Cadastro rápido",
    "",
    "> _Preencha os campos abaixo. Você pode escrever várias linhas onde precisar._",
    "",
    "◇ *𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥*",
    "",
    "*Nome:*",
    "*Idade:*",
    "*Gênero / pronomes:*",
    "",
    "◇ *𝗣𝗘𝗥𝗦𝗢𝗡𝗔𝗚𝗘𝗠*",
    "",
    "*Aparência (opcional):*",
    "*Personalidade:*",
    "*História (opcional):*",
    "",
    "◇ *𝗣𝗥𝗢𝗙𝗜𝗦𝗦Ã𝗢*",
    "",
    "*Profissão:*",
    "› _Obrigatória. Veja as opções e detalhes no site:_",
    "https://pokemon-hub-web-self.vercel.app/sistemas/profissoes",
    "",
    "✦ *𝗝𝗢𝗥𝗡𝗔𝗗𝗔*",
    "",
    "*Pokémon inicial:*",
    "",
    `⌖ Região · *${options.regionDisplayName}*`,
    "",
    "› _Envie a ficha preenchida. Aparência e História podem ficar em branco._",
    "› _A formatação não precisa ficar idêntica; os campos serão reconhecidos pelo conteúdo._",
    "› _Você pode usar o número ou o nome do inicial. Para rever as opções, use `/iniciais`._",
  ].join("\n");
}

export function renderMissingFullFormFields(
  fields: readonly RegistrationConversationField[],
  starterOptions: readonly string[],
): string {
  const label = (field: RegistrationConversationField): string => {
    switch (field) {
      case "trainerName":
        return "Nome";
      case "age":
        return "Idade";
      case "genderPronouns":
        return "Gênero / pronomes";
      case "appearance":
        return "Aparência";
      case "personality":
        return "Personalidade";
      case "backstory":
        return "História";
      case "profession":
        return "Profissão";
      case "starterFormId":
        return "Pokémon inicial";
    }
  };

  const lines = [
    "△ *𝗙𝗔𝗟𝗧𝗔 𝗣𝗢𝗨𝗖𝗢*",
    "　Recepção · Complete só o necessário",
    "",
    ...fields.map((field) => `◇ *${label(field)}*`),
    "",
    "› _Pode enviar somente os campos acima; não precisa repetir a ficha inteira._",
  ];

  if (fields.includes("profession")) {
    lines.push(
      "",
      "◇ *𝗣𝗥𝗢𝗙𝗜𝗦𝗦Ã𝗢*",
      "",
      "› _Veja as profissões e os detalhes no site:_",
      "https://pokemon-hub-web-self.vercel.app/sistemas/profissoes",
      "",
      "› _Pode responder só com o nome, por exemplo: `Artesão`._",
    );
  }

  if (fields.includes("starterFormId")) {
    lines.push(
      "",
      "✦ *𝗣𝗢𝗞É𝗠𝗢𝗡 𝗜𝗡𝗜𝗖𝗜𝗔𝗟*",
      "",
      numberedOptions(starterOptions),
      "",
      "› _Se faltar apenas o inicial, pode responder só com o número ou nome._",
    );
  }
  return lines.join("\n");
}

export function renderReview(input: RegistrationReviewRenderInput): string {
  return [
    "▣ *𝗥𝗘𝗩𝗜𝗦Ã𝗢 𝗗𝗢 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢*",
    `　${input.trainerName} · ${input.regionDisplayName}`,
    "",
    "◇ *𝗧𝗥𝗘𝗜𝗡𝗔𝗗𝗢𝗥*",
    "",
    `*Nome:* ${input.trainerName}`,
    `*Idade:* ${input.age}`,
    `*Gênero / pronomes:* ${input.genderPronouns}`,
    "",
    "◇ *𝗣𝗘𝗥𝗦𝗢𝗡𝗔𝗚𝗘𝗠*",
    "",
    `*Aparência:* ${input.appearance}`,
    "",
    `*Personalidade:* ${input.personality}`,
    "",
    `*História:* ${input.backstory}`,
    "",
    `*Profissão:* ${trainerProfessionDisplayName(input.profession)}`,
    "",
    "✦ *𝗝𝗢𝗥𝗡𝗔𝗗𝗔*",
    "",
    `*Pokémon inicial:* ${input.starterDisplayName}`,
    `*Região:* ${input.regionDisplayName}`,
    "",
    "┄┄ ◇ *𝗢 𝗤𝗨𝗘 𝗙𝗔𝗭𝗘𝗥?* ┄┄",
    "",
    "`01` Enviar para análise",
    "`02` Corrigir informações",
    "`03` Continuar depois",
    "",
    "› _Responda com o número da opção._",
  ].join("\n");
}

export function renderDraftProgress(input: RegistrationDraftProgressRenderInput): string {
  return [
    "▣ *𝗙𝗜𝗖𝗛𝗔 𝗘𝗠 𝗔𝗡𝗗𝗔𝗠𝗘𝗡𝗧𝗢*",
    "　Recepção · Rascunho",
    "",
    `*Nome:* ${draftValue(input.trainerName)}`,
    `*Idade:* ${draftValue(input.age)}`,
    `*Gênero / pronomes:* ${draftValue(input.genderPronouns)}`,
    `*Aparência:* ${draftValue(input.appearance)}`,
    `*Personalidade:* ${draftValue(input.personality)}`,
    `*História:* ${draftValue(input.backstory)}`,
    `*Profissão:* ${trainerProfessionDisplayName(input.profession)}`,
    `*Pokémon inicial:* ${draftValue(input.starterDisplayName)}`,
    `*Região:* ${input.regionDisplayName}`,
  ].join("\n");
}

export function renderEditSelect(): string {
  return [
    "✎ *𝗖𝗢𝗥𝗥𝗜𝗚𝗜𝗥 𝗙𝗜𝗖𝗛𝗔*",
    "　Recepção · Registro",
    "",
    "`01` Nome",
    "`02` Idade",
    "`03` Gênero / pronomes",
    "`04` Aparência",
    "`05` Personalidade",
    "`06` História",
    "`07` Profissão",
    "`08` Pokémon inicial",
    "",
    "‹ `09` Voltar",
    "",
    "› _Responda com o número do campo._",
  ].join("\n");
}

export function renderPause(): string {
  return [
    "💾 *𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢 𝗦𝗔𝗟𝗩𝗢*",
    "　Recepção · Rascunho",
    "",
    "> _Seu progresso foi salvo._",
    "",
    "› _Quando quiser continuar, use `/registrar`._",
  ].join("\n");
}

export function renderResumeMenu(): string {
  return [
    "▣ *𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢 𝗘𝗠 𝗔𝗡𝗗𝗔𝗠𝗘𝗡𝗧𝗢*",
    "　Recepção · Rascunho encontrado",
    "",
    "`01` Continuar de onde parei",
    "`02` Ver ficha atual",
    "`03` Recomeçar",
    "",
    "› _Responda com o número da opção._",
  ].join("\n");
}

export function renderRestartConfirm(): string {
  return [
    "△ *𝗥𝗘𝗖𝗢𝗠𝗘Ç𝗔𝗥 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢?*",
    "",
    "> _Isso apaga o rascunho atual._",
    "",
    "`01` Sim, recomeçar",
    "`02` Cancelar",
    "",
    "› _Responda com o número da opção._",
  ].join("\n");
}

export function renderValidationRetry(message: string, prompt: string): string {
  return [`△ *${message.trim()}*`, "", prompt.trim()].join("\n");
}
