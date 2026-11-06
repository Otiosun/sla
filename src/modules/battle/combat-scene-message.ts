import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export const MIN_COMBAT_SCENE_WORDS = 50;
export interface CombatSceneMessage {
  readonly command: string | null;
  readonly narrative: string;
  readonly wordCount: number;
  readonly explicitScene: boolean;
}

/** Only authored prose is counted; no inference about quality or success. */
export function authoredCombatText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*(?:`|$)/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*>/u.test(line))
    .join("\n")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/@[\p{L}\p{N}_.:+-]+/gu, " ");
}

export function parseCombatSceneMessage(
  text: string,
  knownArguments: Readonly<Record<string, readonly string[]>> = {},
): Result<CombatSceneMessage> {
  const authored = authoredCombatText(text);
  const directives = [...authored.matchAll(/(^|\s)\/(\p{L}[\p{L}\p{N}_-]*)(?=\s|$)/gu)];
  const scenes = directives.filter((entry) => entry[2]?.toLocaleLowerCase("pt-BR") === "cena");
  const actions = directives.filter((entry) => entry[2]?.toLocaleLowerCase("pt-BR") !== "cena");
  if (actions.length > 1 || scenes.length > 1)
    return err(appError("VALIDATION_FAILED", "Use apenas uma diretiva mecânica por Cena."));
  let command: string | null = null;
  let narrative = authored;
  const action = actions[0];
  if (action !== undefined) {
    const name = action[2]!.toLocaleLowerCase("pt-BR");
    if (!["movimento", "trocar", "capturar", "fugir", "desistir"].includes(name)) {
      return err(appError("VALIDATION_FAILED", "Diretiva de combate não reconhecida."));
    }
    const start = action.index! + action[1]!.length;
    const end = action.index! + action[0].length;
    const rest = authored.slice(end);
    const spaces = /^\s*/u.exec(rest)![0];
    const argumentStart = end + spaces.length;
    let argument = "";
    if (name === "movimento" || name === "trocar") {
      const token = /^([1-9]\d*)(?=$|\s|[,;!?](?=$|\s)|\.(?=$|\s))/u.exec(
        authored.slice(argumentStart),
      );
      if (token !== null) argument = token[1]!;
      if (argument && Number(argument) > (name === "movimento" ? 4 : 6))
        return err(appError("VALIDATION_FAILED", "Slot de combate fora das opções disponíveis."));
    }
    if (
      ((name === "movimento" || name === "trocar") && argument.length === 0) ||
      name === "capturar"
    ) {
      const tail = authored.slice(argumentStart);
      const matches = (knownArguments[name] ?? [])
        .filter(
          (candidate) =>
            tail.slice(0, candidate.length).normalize("NFC").toLocaleLowerCase("pt-BR") ===
              candidate.normalize("NFC").toLocaleLowerCase("pt-BR") &&
            /^(?:$|\s|[,;!?](?:$|\s)|\.(?:$|\s))/u.test(tail.slice(candidate.length)),
        )
        .sort((a, b) => b.length - a.length);
      argument = matches[0] ?? "";
      if (
        argument.length === 0 &&
        (name !== "capturar" || (tail.trim().length > 0 && !spaces.includes("\n")))
      ) {
        return err(
          appError(
            "VALIDATION_FAILED",
            "Use um número de movimento/equipe ou o nome exato da Ball, separado da Cena.",
          ),
        );
      }
    }
    command = `/${name}${argument ? " " + argument : ""}`;
    narrative = authored.slice(0, start) + " " + authored.slice(argumentStart + argument.length);
  }
  narrative = narrative.replace(/(^|\s)\/cena(?=\s|$)/giu, " ");
  const words = narrative.match(/\p{L}[\p{L}\p{M}]*(?:['’-][\p{L}\p{M}]+)*/gu) ?? [];
  return ok({
    command,
    narrative: narrative.trim(),
    wordCount: words.length,
    explicitScene: scenes.length === 1,
  });
}
