export type SceneActionIntent =
  | { readonly type: "USE_MOVE"; readonly moveRef: string }
  | { readonly type: "SWITCH"; readonly switchSlot: number }
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
      readonly reason: "MULTIPLE_DIRECTIVES" | "INVALID_DIRECTIVE";
    }
  | { readonly kind: "ACTION"; readonly intent: SceneActionIntent };

const DIRECTIVE = /(^|\s)\/(movimento|trocar|capturar|fugir|desistir)(?=\s|$)/giu;

function parseDirective(command: string, argument: string): SceneActionIntent | null {
  const normalized = command.toLocaleLowerCase("pt-BR");
  if (normalized === "fugir") return { type: "FLEE" };
  if (normalized === "desistir") return { type: "SURRENDER" };

  if (normalized === "movimento") {
    if (argument.length === 0) return null;
    const firstToken = (argument.split(/\s+/, 1)[0] ?? "").replace(/[_,.!?;:*~`]+$/gu, "");
    return /^\d+$/u.test(firstToken)
      ? { type: "USE_MOVE", moveRef: firstToken }
      : { type: "USE_MOVE", moveRef: argument };
  }

  if (normalized === "trocar") {
    // A Cena may continue on the same line as the mechanical directive.
    // Read exactly one positive numeric slot; never interpret its prose as
    // another parameter or accept malformed numbers such as 2abc / 2.5.
    const slotToken =
      /^([1-9]\d*)(?=$|\s|[,;!?](?=$|\s)|\.(?=$|\s))/u.exec(argument)?.[1];
    if (slotToken === undefined) return null;
    const slot = Number(slotToken);
    return Number.isSafeInteger(slot) ? { type: "SWITCH", switchSlot: slot } : null;
  }

  if (normalized === "capturar") {
    return { type: "CAPTURE", captureRef: argument };
  }

  return null;
}

export function parseSceneAction(text: string | null): SceneActionParseResult {
  if (text === null || text.trim().length === 0) return { kind: "NONE" };

  const matches = [...text.matchAll(DIRECTIVE)];
  if (matches.length === 0) return { kind: "NONE" };
  if (matches.length > 1) return { kind: "INVALID", reason: "MULTIPLE_DIRECTIVES" };

  const found = matches[0];
  if (found === undefined) return { kind: "NONE" };

  const command = found[2] ?? "";
  const directiveEnd = (found.index ?? 0) + found[0].length;
  const lineEnd = text.indexOf("\n", directiveEnd);
  const argument = text.slice(directiveEnd, lineEnd < 0 ? text.length : lineEnd).trim();
  const intent = parseDirective(command, argument);

  return intent === null
    ? { kind: "INVALID", reason: "INVALID_DIRECTIVE" }
    : { kind: "ACTION", intent };
}
