export type SceneActionIntent =
  | { readonly type: "USE_MOVE"; readonly moveSlot: number }
  | { readonly type: "SWITCH"; readonly switchSlot: number }
  | { readonly type: "USE_ITEM"; readonly itemRef: string }
  | { readonly type: "CAPTURE"; readonly captureRef: string }
  | { readonly type: "FLEE" }
  | { readonly type: "SURRENDER" };

export interface SceneActionBinding {
  readonly battleId: string;
  readonly battleVersion: number;
  readonly actorParticipantId: string;
  readonly externalMessageId: string;
}

export type SceneActionParseResult =
  | { readonly kind: "NONE" }
  | {
      readonly kind: "INVALID";
      readonly reason: "MULTIPLE_DIRECTIVES" | "DIRECTIVE_NOT_FINAL" | "INVALID_DIRECTIVE";
    }
  | { readonly kind: "ACTION"; readonly intent: SceneActionIntent };

function directive(line: string): SceneActionIntent | null {
  const match = /^(?:\/)(movimento|trocar|item|capturar|fugir|desistir)(?:\s+(.+?))?$/iu.exec(line);
  if (match === null) return null;
  const command = match[1]?.toLocaleLowerCase("pt-BR");
  const argument = match[2]?.trim();
  if (command === "fugir" && argument === undefined) return { type: "FLEE" };
  if (command === "desistir" && argument === undefined) return { type: "SURRENDER" };
  if (
    (command === "movimento" || command === "trocar") &&
    argument !== undefined &&
    /^\d+$/u.test(argument)
  ) {
    const slot = Number(argument);
    return Number.isSafeInteger(slot) && slot > 0
      ? command === "movimento"
        ? { type: "USE_MOVE", moveSlot: slot }
        : { type: "SWITCH", switchSlot: slot }
      : null;
  }
  if (command === "item" && argument !== undefined) return { type: "USE_ITEM", itemRef: argument };
  if (command === "capturar" && argument !== undefined)
    return { type: "CAPTURE", captureRef: argument };
  return null;
}

export function parseSceneAction(text: string | null): SceneActionParseResult {
  if (text === null) return { kind: "NONE" };
  const lines = text.split(/\r?\n/u);
  const directives = lines
    .map((line, index) => ({ index, action: directive(line.trim()), raw: line.trim() }))
    .filter((entry) => entry.raw.startsWith("/"));
  if (directives.length === 0) return { kind: "NONE" };
  if (directives.length > 1) return { kind: "INVALID", reason: "MULTIPLE_DIRECTIVES" };
  const found = directives[0];
  if (
    found === undefined ||
    found.index !== lines.map((line) => line.trim()).findLastIndex((line) => line.length > 0)
  )
    return { kind: "INVALID", reason: "DIRECTIVE_NOT_FINAL" };
  return found.action === null
    ? { kind: "INVALID", reason: "INVALID_DIRECTIVE" }
    : { kind: "ACTION", intent: found.action };
}
