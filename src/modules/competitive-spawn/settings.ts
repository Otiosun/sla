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
}

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
