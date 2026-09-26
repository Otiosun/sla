export const TRAINER_PROFESSIONS = [
  { id: "CRIADOR", label: "Criador", tier: "COMMON", documentedPrice: null },
  { id: "PESQUISADOR", label: "Pesquisador", tier: "COMMON", documentedPrice: null },
  { id: "EXPLORADOR", label: "Explorador", tier: "COMMON", documentedPrice: null },
  { id: "RANGER", label: "Ranger", tier: "COMMON", documentedPrice: null },
  { id: "PESCADOR", label: "Pescador", tier: "COMMON", documentedPrice: null },
  { id: "ARTESAO", label: "Artesão", tier: "COMMON", documentedPrice: null },
  { id: "COORDENADOR", label: "Coordenador", tier: "COMMON", documentedPrice: null },
  { id: "FOTOGRAFO", label: "Fotógrafo", tier: "PREMIUM", documentedPrice: 50 },
  { id: "CAMPEAO", label: "Campeão", tier: "PREMIUM", documentedPrice: null },
  { id: "COLECIONADOR_TCG", label: "Colecionador — TCG", tier: "PREMIUM", documentedPrice: 50 },
] as const;

export type TrainerProfessionId = (typeof TRAINER_PROFESSIONS)[number]["id"];
export type TrainerProfessionSelection = TrainerProfessionId | "—";

function normalized(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[–—-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROFESSION_BY_ALIAS = new Map<string, TrainerProfessionId>([
  ["criador", "CRIADOR"],
  ["pesquisador", "PESQUISADOR"],
  ["explorador", "EXPLORADOR"],
  ["ranger", "RANGER"],
  ["pescador", "PESCADOR"],
  ["artesao", "ARTESAO"],
  ["coordenador", "COORDENADOR"],
  ["fotografo", "FOTOGRAFO"],
  ["campeao", "CAMPEAO"],
  ["colecionador tcg", "COLECIONADOR_TCG"],
  ["colecionador", "COLECIONADOR_TCG"],
  ["tcg", "COLECIONADOR_TCG"],
]);

const EMPTY_ALIASES = new Set([
  "",
  "-",
  "—",
  "pular",
  "pula",
  "depois",
  "sem",
  "nenhuma",
  "nenhum",
  "sem profissao",
]);

export function normalizeTrainerProfession(value: string): TrainerProfessionSelection | null {
  const key = normalized(value);
  if (EMPTY_ALIASES.has(key)) return "—";
  return PROFESSION_BY_ALIAS.get(key) ?? null;
}

export function trainerProfessionDisplayName(value: TrainerProfessionSelection | undefined): string {
  if (value === undefined || value === "—") return "—";
  return TRAINER_PROFESSIONS.find((profession) => profession.id === value)?.label ?? "—";
}

export function isTrainerProfessionId(value: unknown): value is TrainerProfessionId {
  return (
    typeof value === "string" &&
    TRAINER_PROFESSIONS.some((profession) => profession.id === value)
  );
}
