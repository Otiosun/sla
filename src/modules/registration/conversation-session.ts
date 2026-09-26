import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  normalizeTrainerProfession,
  type TrainerProfessionSelection,
} from "../player/professions.js";
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
  | "profession"
  | "starterFormId";

export interface RegistrationConversationWorkingDraft {
  readonly trainerName?: string;
  readonly age?: number;
  readonly genderPronouns?: string;
  readonly appearance?: string;
  readonly personality?: string;
  readonly backstory?: string;
  readonly profession?: TrainerProfessionSelection;
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
  readonly expectedReplyOutboxIdempotencyKey: string | null;
}

export interface BeginRegistrationConversationInput {
  readonly regionId: string;
  readonly baseDraft?: RegistrationDraftInput;
  readonly baseRevision?: number;
}

export interface StartRegistrationConversationInput extends BeginRegistrationConversationInput {
  readonly mode: RegistrationEditingMode;
}

export interface ParsedRegistrationTemplateDraft {
  readonly trainerName?: string;
  readonly age?: number;
  readonly genderPronouns?: string;
  readonly appearance?: string;
  readonly personality?: string;
  readonly backstory?: string;
  readonly profession?: TrainerProfessionSelection;
  readonly starterFormId?: string;
}

export interface ParsedFullRegistrationTemplate {
  readonly trainerName: string;
  readonly age: number;
  readonly genderPronouns: string;
  readonly appearance: string;
  readonly personality: string;
  readonly backstory: string;
  readonly profession: TrainerProfessionSelection;
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
    profession?: TrainerProfessionSelection;
    starterFormId?: string;
    regionId: string;
    schemaVersion: number;
  };
  persistedRevision: number | null;
  dirty: boolean;
  expectedReplyOutboxIdempotencyKey: string | null;
}

const GUIDED_FIELDS: readonly RegistrationConversationField[] = [
  "trainerName",
  "age",
  "genderPronouns",
  "appearance",
  "personality",
  "backstory",
  "profession",
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
    expectedReplyOutboxIdempotencyKey: session.expectedReplyOutboxIdempotencyKey,
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
    if (
      field === "profession"
        ? typeof value !== "string" || normalizeTrainerProfession(value) === null
        : value === undefined || (typeof value === "string" && value.trim().length === 0)
    ) {
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
  if (field === "profession") {
    const profession = normalizeTrainerProfession(value);
    return profession === null
      ? err(appError("VALIDATION_FAILED", "Profissão inválida", { fields: [field] }))
      : ok(profession);
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
    .replace(/[*_`~]/g, "")
    .replace(/[()]+/g, " ")
    .replace(/^[^a-z0-9]+/g, "")
    .replace(/[^a-z0-9/ ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanInlineValue(value: string): string {
  return value
    .trim()
    .replace(/^[*_`~]+\s*/u, "")
    .replace(/\s*[*_`~]+$/u, "")
    .trim();
}

export function normalizeRegistrationChoice(rawValue: string): string {
  const normalized = normalizedLabel(rawValue);
  const numeric = normalized.match(/^#?0*(\d+)$/);
  return numeric?.[1] === undefined ? normalized : String(Number(numeric[1]));
}

export function parseRegistrationModeChoice(rawValue: string): RegistrationEditingMode | null {
  const normalized = normalizedLabel(rawValue);
  const numericTokens = [...normalized.matchAll(/(?:^|\s)#?0*([12])(?=\s|$)/g)].map(
    (match) => match[1],
  );
  const uniqueNumericTokens = [...new Set(numericTokens)];
  if (uniqueNumericTokens.length === 1) {
    return uniqueNumericTokens[0] === "1" ? "GUIDED" : "FULL";
  }

  switch (normalized) {
    case "guiado":
    case "passo a passo":
    case "modo guiado":
      return "GUIDED";
    case "completo":
    case "completa":
    case "ficha":
    case "ficha completa":
    case "modo completo":
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
    case "aparencia opcional":
      return "appearance";
    case "personalidade":
      return "personality";
    case "historia":
    case "historia opcional":
    case "historia / resumo":
    case "historia/resumo":
    case "resumo":
      return "backstory";
    case "profissao":
    case "profissao opcional":
      return "profession";
    case "inicial":
    case "pokemon inicial":
      return "starterFormId";
    default:
      return null;
  }
}

function registrationTemplateFields(text: string): Set<RegistrationConversationField> {
  const fields = new Set<RegistrationConversationField>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;
    const field = fieldForLabel(line.slice(0, colonIndex));
    if (field !== null) fields.add(field);
  }
  return fields;
}

export function looksLikeRegistrationTemplate(text: string): boolean {
  return registrationTemplateFields(text).size > 0;
}

export function looksLikeFullRegistrationTemplate(text: string): boolean {
  const fields = registrationTemplateFields(text);
  return fields.has("trainerName") && fields.has("age") && fields.size >= 4;
}

export function parsePartialRegistrationTemplate(
  text: string,
): Result<ParsedRegistrationTemplateDraft> {
  const values = new Map<RegistrationConversationField, string>();
  const duplicates = new Set<RegistrationConversationField>();
  let currentField: RegistrationConversationField | null = null;
  let pendingBlankLine = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      if (currentField !== null && values.has(currentField)) pendingBlankLine = true;
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex >= 0) {
      const field = fieldForLabel(line.slice(0, colonIndex));
      if (field !== null) {
        if (values.has(field)) duplicates.add(field);
        const inlineValue = cleanInlineValue(line.slice(colonIndex + 1));
        if (inlineValue.length > 0) values.set(field, inlineValue);
        currentField = field;
        pendingBlankLine = false;
        continue;
      }
    }

    if (currentField !== null) {
      const currentValue = values.get(currentField);
      if (currentValue === undefined) {
        values.set(currentField, line);
      } else {
        values.set(currentField, `${currentValue}${pendingBlankLine ? "\n\n" : "\n"}${line}`);
      }
      pendingBlankLine = false;
    }
  }

  if (duplicates.size > 0) {
    return err(
      appError("VALIDATION_FAILED", "Campos duplicados na ficha", {
        fields: [...duplicates],
      }),
    );
  }

  const ageRaw = values.get("age");
  const age = ageRaw === undefined ? undefined : Number(ageRaw);
  if (age !== undefined && (!Number.isSafeInteger(age) || age <= 0)) {
    return err(appError("VALIDATION_FAILED", "Idade inválida", { fields: ["age"] }));
  }

  const trainerName = values.get("trainerName");
  const genderPronouns = values.get("genderPronouns");
  const appearance = values.get("appearance");
  const personality = values.get("personality");
  const backstory = values.get("backstory");
  const professionRaw = values.get("profession");
  const profession =
    professionRaw === undefined ? undefined : normalizeTrainerProfession(professionRaw);
  if (profession === null) {
    return err(appError("VALIDATION_FAILED", "Profissão inválida", { fields: ["profession"] }));
  }
  const starterFormId = values.get("starterFormId");
  const parsed: ParsedRegistrationTemplateDraft = {
    ...(trainerName === undefined ? {} : { trainerName }),
    ...(age === undefined ? {} : { age }),
    ...(genderPronouns === undefined ? {} : { genderPronouns }),
    ...(appearance === undefined ? {} : { appearance }),
    ...(personality === undefined ? {} : { personality }),
    ...(backstory === undefined ? {} : { backstory }),
    ...(profession === undefined ? {} : { profession }),
    ...(starterFormId === undefined ? {} : { starterFormId }),
  };
  if (Object.keys(parsed).length === 0) {
    return err(appError("VALIDATION_FAILED", "Nenhum campo da ficha foi reconhecido"));
  }
  return ok(parsed);
}

export function parseFullRegistrationTemplate(
  text: string,
): Result<ParsedFullRegistrationTemplate> {
  const parsed = parsePartialRegistrationTemplate(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const missing: string[] = [];
  if (value.trainerName === undefined) missing.push("trainerName");
  if (value.age === undefined) missing.push("age");
  if (value.genderPronouns === undefined) missing.push("genderPronouns");
  if (value.personality === undefined) missing.push("personality");
  if (value.profession === undefined) missing.push("profession");
  if (value.starterFormId === undefined) missing.push("starterFormId");
  if (missing.length > 0) {
    return err(appError("VALIDATION_FAILED", "Ficha incompleta ou inválida", { fields: missing }));
  }

  const trainerName = value.trainerName;
  const age = value.age;
  const genderPronouns = value.genderPronouns;
  const personality = value.personality;
  const profession = value.profession;
  const starterFormId = value.starterFormId;
  if (
    trainerName === undefined ||
    age === undefined ||
    genderPronouns === undefined ||
    personality === undefined ||
    profession === undefined ||
    starterFormId === undefined
  ) {
    return err(appError("VALIDATION_FAILED", "Ficha incompleta ou inválida"));
  }

  return ok({
    trainerName,
    age,
    genderPronouns,
    appearance: value.appearance ?? "—",
    personality,
    backstory: value.backstory ?? "—",
    profession,
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
      expectedReplyOutboxIdempotencyKey: null,
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
      expectedReplyOutboxIdempotencyKey: null,
    };
    this.sessions.set(playerId, session);
    return snapshot(session);
  }

  public get(playerId: PlayerId): RegistrationConversationSession | null {
    const session = this.sessions.get(playerId);
    return session === undefined ? null : snapshot(session);
  }

  public expectReply(
    playerId: PlayerId,
    outboxIdempotencyKey: string,
  ): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    const key = outboxIdempotencyKey.trim();
    if (key.length === 0) {
      return err(appError("VALIDATION_FAILED", "Expected registration reply key is empty"));
    }
    session.expectedReplyOutboxIdempotencyKey = key;
    return ok(snapshot(session));
  }

  public clearExpectedReply(playerId: PlayerId): Result<RegistrationConversationSession> {
    const session = this.sessions.get(playerId);
    if (session === undefined) {
      return err(appError("NOT_FOUND", "Registration conversation is not active"));
    }
    session.expectedReplyOutboxIdempotencyKey = null;
    return ok(snapshot(session));
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
    const mode = parseRegistrationModeChoice(rawValue);
    if (mode === null) {
      return err(
        appError("VALIDATION_FAILED", "Escolha 1 para modo guiado ou 2 para ficha completa"),
      );
    }
    session.mode = mode;
    session.currentField = mode === "GUIDED" ? firstMissingField(session.working) : null;
    session.expectedReplyOutboxIdempotencyKey = null;
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
    session.expectedReplyOutboxIdempotencyKey = null;
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
    } else if (field === "profession") {
      session.working.profession = parsed.value as TrainerProfessionSelection;
    } else {
      session.working[field] = parsed.value as string;
    }
    session.dirty = true;
    session.expectedReplyOutboxIdempotencyKey = null;
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
    } else if (field === "profession") {
      session.working.profession = parsed.value as TrainerProfessionSelection;
    } else {
      session.working[field] = parsed.value as string;
    }
    session.currentField = nextGuidedField(field);
    while (session.currentField !== null && session.working[session.currentField] !== undefined) {
      session.currentField = nextGuidedField(session.currentField);
    }
    session.dirty = true;
    session.expectedReplyOutboxIdempotencyKey = null;
    return ok(snapshot(session));
  }

  public clear(playerId: PlayerId): void {
    this.sessions.delete(playerId);
  }
}
