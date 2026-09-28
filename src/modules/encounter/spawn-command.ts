export type SpawnFirstTurn = "PLAYER" | "WILD";

export interface SpawnCommandOptions {
  readonly automatic: boolean;
  readonly quantity: number;
  readonly speciesReference: string | null;
  readonly forcedLevel: number | null;
  readonly forcedShiny: boolean;
  readonly firstTurn: SpawnFirstTurn | null;
  readonly openingMoveReference: string | null;
}

export type SpawnCommandParseResult =
  | { readonly ok: true; readonly value: SpawnCommandOptions }
  | { readonly ok: false; readonly message: string };

const AUTO = new Set(["auto", "automatico", "automatic"]);
const SHINY = new Set(["shiny"]);
const LEVEL = new Set(["nv", "nivel", "level", "lvl"]);
const QUANTITY = new Set(["qtd", "quantidade"]);
const OPENING_MOVE = new Set(["ataque", "atk", "mov", "movimento"]);
const INITIATIVE = new Set(["inicio", "comeca", "primeiro"]);
const PLAYER = new Set(["jogador", "player", "treinador"]);
const WILD = new Set(["selvagem", "wild", "pokemon"]);

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[,:;.!?]+$/gu, "");
}

function modifierKind(token: string): "AUTO" | "SHINY" | "LEVEL" | "QUANTITY" | "MOVE" | "INITIATIVE" | null {
  const value = normalize(token);
  if (AUTO.has(value)) return "AUTO";
  if (SHINY.has(value)) return "SHINY";
  if (LEVEL.has(value) || /^(?:nv|nivel|level|lvl)\d+$/u.test(value)) return "LEVEL";
  if (QUANTITY.has(value)) return "QUANTITY";
  if (OPENING_MOVE.has(value)) return "MOVE";
  if (INITIATIVE.has(value)) return "INITIATIVE";
  return null;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function duplicate(field: string): SpawnCommandParseResult {
  return { ok: false, message: `O modificador *${field}* foi informado mais de uma vez.` };
}

export function parseSpawnCommand(text: string | null): SpawnCommandParseResult {
  const raw = text?.trim() ?? "";
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? "";
  const source = firstLine.split(/\s+/u);
  if (source.length === 0 || normalize(source[0] ?? "") !== "/spawn") {
    return { ok: false, message: "Diretiva /spawn inválida." };
  }

  const tokens = source.slice(1).filter((token) => !token.startsWith("@"));
  let automatic = false;
  let shiny = false;
  let level: number | null = null;
  let quantity: number | null = null;
  let firstTurn: SpawnFirstTurn | null = null;
  let openingMove: string | null = null;
  const species: string[] = [];

  let seenAuto = false;
  let seenShiny = false;
  let seenLevel = false;
  let seenQuantity = false;
  let seenInitiative = false;
  let seenMove = false;
  let structuralModifiersStarted = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] ?? "";
    const token = normalize(rawToken);
    const kind = modifierKind(rawToken);

    if (kind === "AUTO") {
      if (seenAuto) return duplicate("auto");
      seenAuto = true;
      automatic = true;
      continue;
    }

    if (kind === "SHINY") {
      if (seenShiny) return duplicate("shiny");
      seenShiny = true;
      shiny = true;
      continue;
    }

    if (kind === "LEVEL") {
      structuralModifiersStarted = true;
      if (seenLevel) return duplicate("nível");
      seenLevel = true;
      const attached = token.match(/^(?:nv|nivel|level|lvl)(\d+)$/u)?.[1];
      const candidate = attached ?? tokens[index + 1];
      const parsed = candidate === undefined ? null : parsePositiveInteger(normalize(candidate));
      if (parsed === null || parsed < 1 || parsed > 100) {
        return { ok: false, message: "O nível do spawn deve estar entre 1 e 100." };
      }
      level = parsed;
      if (attached === undefined) index += 1;
      continue;
    }

    if (kind === "QUANTITY") {
      structuralModifiersStarted = true;
      if (seenQuantity) return duplicate("quantidade");
      seenQuantity = true;
      const candidate = tokens[index + 1];
      const parsed = candidate === undefined ? null : parsePositiveInteger(normalize(candidate));
      if (parsed === null || parsed < 1 || parsed > 6) {
        return { ok: false, message: "A quantidade do spawn deve estar entre 1 e 6." };
      }
      quantity = parsed;
      index += 1;
      continue;
    }

    if (kind === "INITIATIVE") {
      structuralModifiersStarted = true;
      if (seenInitiative) return duplicate("início");
      seenInitiative = true;
      const actorRaw = tokens[index + 1];
      const actor = actorRaw === undefined ? "" : normalize(actorRaw);
      if (PLAYER.has(actor)) firstTurn = "PLAYER";
      else if (WILD.has(actor)) firstTurn = "WILD";
      else {
        return {
          ok: false,
          message: "Use *início jogador* ou *início selvagem*.",
        };
      }
      index += 1;
      continue;
    }

    if (kind === "MOVE") {
      structuralModifiersStarted = true;
      if (seenMove) return duplicate("ataque");
      seenMove = true;
      const parts: string[] = [];
      let cursor = index + 1;
      while (cursor < tokens.length) {
        const next = tokens[cursor] ?? "";
        if (modifierKind(next) !== null) break;
        parts.push(next);
        cursor += 1;
      }
      const reference = parts.join(" ").trim();
      if (reference.length === 0) {
        return { ok: false, message: "Informe o golpe depois de *ataque*." };
      }
      if (reference.length > 80) {
        return { ok: false, message: "O nome do golpe informado é muito longo." };
      }
      openingMove = reference;
      index = cursor - 1;
      continue;
    }

    if (structuralModifiersStarted) {
      return {
        ok: false,
        message:
          "A espécie deve vir antes dos modificadores de nível, início ou ataque. Ex.: `/spawn Poochyena @treinador nv 12 ataque Bite`.",
      };
    }
    species.push(rawToken);
  }

  // Backward compatibility: /spawn @player 3
  if (!seenQuantity && level === null && species.length > 0) {
    const tail = normalize(species[species.length - 1] ?? "");
    const legacyQuantity = parsePositiveInteger(tail);
    if (legacyQuantity !== null) {
      if (legacyQuantity > 6) {
        return { ok: false, message: "A quantidade do spawn deve estar entre 1 e 6." };
      }
      quantity = legacyQuantity;
      species.pop();
    }
  }

  const speciesReference = species.join(" ").trim();
  if (speciesReference.length > 80) {
    return { ok: false, message: "O nome do Pokémon informado é muito longo." };
  }
  const resolvedQuantity = quantity ?? 1;

  if (automatic && openingMove !== null) {
    return {
      ok: false,
      message: "Use *auto* ou *ataque*, não os dois no mesmo spawn.",
    };
  }
  if (openingMove !== null && resolvedQuantity !== 1) {
    return {
      ok: false,
      message: "O fast path com *ataque* aceita apenas um Pokémon selvagem por vez.",
    };
  }

  return {
    ok: true,
    value: {
      automatic,
      quantity: resolvedQuantity,
      speciesReference: speciesReference.length === 0 ? null : speciesReference,
      forcedLevel: level,
      forcedShiny: shiny,
      firstTurn,
      openingMoveReference: openingMove,
    },
  };
}
