export type CompetitiveSpawnToggleAction = "STATUS" | "ENABLE" | "DISABLE";

export interface CompetitiveSpawnSettingUpdateResult {
  readonly enabled: boolean;
  readonly cancelledOpenSpawn: boolean;
}

export interface CompetitiveSpawnSettingsRepository {
  isEnabled(communityGroupId: string): Promise<boolean>;
  setEnabled(input: {
    readonly communityGroupId: string;
    readonly enabled: boolean;
    readonly now: Date;
  }): Promise<CompetitiveSpawnSettingUpdateResult>;
  incenseUntil?(communityGroupId: string, now: Date): Promise<Date | null>;
  setIncense?(input: {
    readonly communityGroupId: string;
    readonly incenseUntil: Date | null;
    readonly now: Date;
  }): Promise<Date | null>;
}

export type CompetitiveSpawnAdminAction =
  | { readonly kind: "STATUS" }
  | { readonly kind: "ENABLE" }
  | { readonly kind: "DISABLE" }
  | { readonly kind: "FORCE" }
  | { readonly kind: "INCENSE_START"; readonly durationMs: number }
  | { readonly kind: "INCENSE_STOP" };

export function parseCompetitiveSpawnToggle(
  text: string | null,
): CompetitiveSpawnToggleAction | null {
  const raw = (text ?? "")
    .trim()
    .replace(/^\/competitivo(?:\s+|$)/iu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");

  if (raw === "" || raw === "status") return "STATUS";
  if (raw === "ativar" || raw === "ligar" || raw === "on") return "ENABLE";
  if (raw === "desativar" || raw === "desligar" || raw === "off") return "DISABLE";
  return null;
}
export function parseCompetitiveSpawnAdminAction(
  text: string | null,
): CompetitiveSpawnAdminAction | null {
  const raw = (text ?? "")
    .trim()
    .replace(/^\/competitivo(?:\s+|$)/iu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");

  const toggle = parseCompetitiveSpawnToggle(text);
  if (toggle !== null) return { kind: toggle };

  if (raw === "forçar" || raw === "forcar" || raw === "force") return { kind: "FORCE" };
  if (raw === "incenso parar" || raw === "incenso stop" || raw === "incenso off") {
    return { kind: "INCENSE_STOP" };
  }

  const incense = /^incenso(?:\s+(\d+)\s*(m|min|h))?$/u.exec(raw);
  if (incense === null) return null;

  const amount = incense[1] === undefined ? 30 : Number(incense[1]);
  const unit = incense[2] ?? "m";
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const durationMs = unit === "h" ? amount * 60 * 60_000 : amount * 60_000;
  if (durationMs < 5 * 60_000 || durationMs > 4 * 60 * 60_000) return null;
  return { kind: "INCENSE_START", durationMs };
}
