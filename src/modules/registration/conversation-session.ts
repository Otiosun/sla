import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationDraftInput } from "./contracts.js";

export type RegistrationEditingMode = "GUIDED" | "FULL";
export type RegistrationConversationMode = "CHOOSING" | RegistrationEditingMode;
export type RegistrationConversationField =
  | "trainerName"
  | "age"
  | "genderPronouns"
  | "appearance"
  | "personality"
  | "backstory"
  | "starterFormId";

export interface RegistrationConversationWorkingDraft {
  readonly trainerName?: string;
  readonly age?: number;
  readonly genderPronouns?: string;
  readonly appearance?: string;
  readonly personality?: string;
  readonly backstory?: string;
  readonly starterFormId?: string;
  readonly regionId: string;
  readonly schemaVersion: number;
}

export interface RegistrationConversationSession {
  readonly playerId: PlayerId;
  readonly mode: RegistrationConversationMode;
  readonly currentField: RegistrationConversationField | null;
  readonly working: RegistrationConversationWorkingDraft;
  readonly persistedRevision: number | null;
  readonly dirty: boolean;
}

export interface BeginRegistrationConversationInput {
  readonly regionId: string;
  readonly baseDraft?: RegistrationDraftInput;
  readonly baseRevision?: number;
}

export interface StartRegistrationConversationInput extends BeginRegistrationConversationInput {
  readonly mode: RegistrationEditingMode;
}

export interface ParsedFullRegistrationTemplate {
  readonly trainerName: string;
  readonly age: number;
  readonly genderPronouns: string;
  readonly appearance: string;
  readonly personality: string;
  readonly backstory: string;
  readonly starterFormId: string;
}

interface MutableSession {
  playerId: PlayerId;
  mode: RegistrationConversationMode;
  currentField: RegistrationConversationField | null;
  working: {
    trainerName?: string;
    age?: number;
    genderPronouns?: string;
    appearance?: string;
    personality?: string;
    backstory?: string;
    starterFormId?: string;
    regionId: string;
    schemaVersion: number;
  };
  persistedRevision: number | null;
  dirty: boolean;
}

const GUIDED_FIELDS: readonly RegistrationConversationField[] = [
  "trainerName",
  "age",
  "genderPronouns",
  "appearance",
  "personality",
  "backstory",
  "starterFormId",
];

function copyWorking(working: MutableSession["working"]): RegistrationConversationWorkingDraft {
  return { ...working };
}

function snapshot(session: MutableSession): RegistrationConversationSession {
  return {
    playerId: session.playerId,
    mode: session.mode,
    currentField: session.currentField,
    working: copyWorking(session.working),
    persistedRevision: session.persistedRevision,
    dirty: session.dirty,
  };
}

function workingDraft(input: BeginRegistrationConversationInput): MutableSession["working"] {
  return input.baseDraft === undefined
    ? { regionId: input.regionId, schemaVersion: 1 }
    : { ...input.baseDraft, regionId: input.regionId };
}

function firstMissingField(
  working: MutableSession["working"],
): RegistrationConversationField | null {
  for (const field of GUIDED_FIELDS) {
    const value = working[field];
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return field;
    }
  }
  return null;
}

function nextGuidedField(
  field: RegistrationConversationField,
): RegistrationConversationField | null {
  const index = GUIDED_FIELDS.indexOf(field);
  return GUIDED_FIELDS[index + 1] ?? null;
}

function parseGuidedValue(
  field: RegistrationConversationField,
  rawValue: string,
): Result<string | number> {
  const value = rawValue.trim();
  if (field === "age") {
    const age = Number(value);
    return Number.isSafeInteger(age) && age > 0
      ? ok(age)
      : err(appError("VALIDATION_FAILED", "Idade inválida", { fields: [field] }));
  }
  return value.length > 0
    ? ok(value)
    : err(appError("VALIDATION_FAILED", "Resposta vazia", { fields: [field] }));
}

function normalizedLabel(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
}

function parseModeChoice(rawValue: string): RegistrationEditingMode | null {
  switch (normalizedLabel(rawValue)) {
    case "1":
    case "guiado":
    case "passo a passo":
      return "GUIDED";
    case "2":
    case "completo":
    case "ficha":
    case "ficha completa":
      return "FULL";
    default:
      return null;
  }
}

function fieldForLabel(label: string): RegistrationConversationField | null {
  switch (normalizedLabel(label)) {
    case "nome":
    case "nome do treinador":
      return "trainerName";
    case "idade":
      return "age";
    case "pronomes":
    case "genero":
    case "genero / pronomes":
    case "genero/pronomes":
      return "genderPronouns";
    case "aparencia":
      return "appearance";
    case "personalidade":
      return "personality";
    case "historia":
    case "historia / resumo":
    case "historia/resumo":
    case "resumo":
      return "backstory";
    case "inicial":
    case "pokemon inicial":
      return "starterFormId";
    default:
      return null;
  }
}

export function parseFullRegistrationTemplate(
  text: string,
): Result<ParsedFullRegistrationTemplate> {
  const values = new Map<RegistrationConversationField, string>();
  const duplicates = new Set<RegistrationConversationField>();
  let currentField: RegistrationConversationField | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex >= 0) {
      const field = fieldForLabel(line.slice(0, colonIndex));
      if (field !== null) {
        if (values.has(field)) duplicates.add(field);
        const inlineValue = line.slice(colonIndex + 1).trim();
        if (inlineValue.length > 0) values.set(field, inlineValue);
        currentField = inlineValue.length === 0 ? field : null;
        continue;
      }
    }

    if (currentField !== null) {
      if (values.has(currentField)) {
        values.set(currentField, `${values.get(currentField)}\n${line}`);
      } else {
        values.set(currentField, line);
      }
      currentField = null;
    }
  }

  if (duplicates.size > 0) {
    return err(
      appError("VALIDATION_FAILED", "Campos duplicados na ficha", {
        fields: [...duplicates],
      }),
    );
  }

  const missing = GUIDED_FIELDS.filter((field) => !values.has(field));
  const age = Number(values.get("age"));
  if (!Number.isSafeInteger(age) || age <= 0) {
    if (!missing.includes("age")) missing.push("age");
  }
  if (missing.length > 0) {
    return err(appError("VALIDATION_FAILED", "Ficha incompleta ou inválida", { fields: missing }));
  }

  const trainerName = values.get("trainerName");
  const genderPronouns = values.get("genderPronouns");
  const appearance = values.get("appearance");
  const personality = values.get("personality");
  const backstory = values.get("backstory");
  const starterFormId = values.get("starterFormId");
  if (
    trainerName === undefined ||
    genderPronouns === undefined ||
    appearance === undefined ||
    personality === undefined ||
    backstory === undefined ||
    starterFormId === undefined
  ) {
    return err(appError("VALIDATION_FAILED", "Ficha incompleta ou inválida"));
  }

  return ok({
    trainerName,
    age,
    genderPronouns,
    appearance,
    personality,
    backstory,
    starterFormId,
  });
}

export class RegistrationConversationSessions {
  private readonly sessions = new Map<PlayerId, MutableSession>();

  public begin(
    playerId: PlayerId,
    input: BeginRegistrationConversationInput,
  ): RegistrationConversationSession {
    const session: MutableSession = {
      playerId,
      mode: "CHOOSING",
      currentField: null,
      working: workingDraft(input),
      persistedRevision: input.baseRevision ?? null,
      dirty: false,
    };
    this.sessions.set(playerId, session);
    return snapshot(session);
  }

  public start(
    playerId: PlayerId,
    input: StartRegistrationConversationInput,
  ): RegistrationConversationSession {
    const working = workingDraft(input);
    const session: MutableSession = {
      playerId,
      mode: input.mode,
      currentField: input.mode === "GUIDED" ? firstMissingField(working) : null,
      working,
      persistedRevision: input.baseRevision ?? null,
      dirty: false,
    };
    this.sessions.set(playerId, session);
    return snapshot(session);
  }

  public get(playerId: PlayerId): RegistrationConversationSession | null {
    const session = this.sessions.get(playerId);
    return session === undefined ? null : snapshot(session);
  }

  public chooseMode(playerId: PlayerId, rawValue: string): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    if (session.mode !== "CHOOSING") {
      return err(
        appError("INVALID_STATE_TRANSITION", "Registration mode has already been selected"),
      );
    }
    const mode = parseModeChoice(rawValue);
    if (mode === null) {
      return err(
        appError("VALIDATION_FAILED", "Escolha 1 para modo guiado ou 2 para ficha completa"),
      );
    }
    session.mode = mode;
    session.currentField = mode === "GUIDED" ? firstMissingField(session.working) : null;
    return ok(snapshot(session));
  }

  public switchMode(
    playerId: PlayerId,
    mode: RegistrationEditingMode,
  ): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    session.mode = mode;
    session.currentField = mode === "GUIDED" ? firstMissingField(session.working) : null;
    return ok(snapshot(session));
  }

  public setField(
    playerId: PlayerId,
    field: RegistrationConversationField,
    value: string | number,
  ): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    const parsed = parseGuidedValue(field, String(value));
    if (!parsed.ok) return parsed;
    if (field === "age") {
      session.working.age = parsed.value as number;
    } else {
      session.working[field] = parsed.value as string;
    }
    session.dirty = true;
    if (session.mode === "GUIDED") session.currentField = firstMissingField(session.working);
    return ok(snapshot(session));
  }

  public applyGuidedAnswer(
    playerId: PlayerId,
    rawValue: string,
  ): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    if (session.mode !== "GUIDED" || session.currentField === null) {
      return err(
        appError("INVALID_STATE_TRANSITION", "Guided registration is not awaiting an answer"),
      );
    }

    const field = session.currentField;
    const parsed = parseGuidedValue(field, rawValue);
    if (!parsed.ok) return parsed;
    if (field === "age") {
      session.working.age = parsed.value as number;
    } else {
      session.working[field] = parsed.value as string;
    }
    session.currentField = nextGuidedField(field);
    while (session.currentField !== null && session.working[session.currentField] !== undefined) {
      session.currentField = nextGuidedField(session.currentField);
    }
    session.dirty = true;
    return ok(snapshot(session));
  }

  public clear(playerId: PlayerId): void {
    this.sessions.delete(playerId);
  }
}
