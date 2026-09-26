import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CommunityChatContext } from "../community/contracts.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";
import {
  renderDraftProgress,
  renderEditAcknowledgement,
  renderEditField,
  renderEditSelect,
  renderFullForm,
  renderGuidedAcknowledgement,
  renderGuidedField,
  renderModeSelect,
  renderMissingFullFormFields,
  renderPause,
  renderRestartConfirm,
  renderResumeMenu,
  renderReview,
  renderStarterOptions,
  renderValidationRetry,
} from "./conversation-renderer.js";
import {
  looksLikeFullRegistrationTemplate,
  looksLikeRegistrationTemplate,
  normalizeRegistrationChoice,
  parsePartialRegistrationTemplate,
  parseRegistrationModeChoice,
  type RegistrationConversationField,
  type RegistrationConversationSession,
  type RegistrationConversationSessions,
} from "./conversation-session.js";
import {
  type RegistrationConversationField as PersistedRegistrationConversationField,
  REGISTRATION_CONVERSATION_FIELDS,
  type RegistrationConversationRecord,
} from "./conversation-state.js";
import type { RegistrationService } from "./service.js";
import { validateRegistrationDraft } from "./validation.js";

interface CommunityContextResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

interface PlayerIdentityResolver {
  resolvePlayer(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<Result<{ readonly playerId: PlayerId; readonly state: string }>>;
}

interface RegistrationSetup {
  readonly regionId: string;
  readonly regionDisplayName: string;
  readonly starterOptions: readonly {
    readonly formId: string;
    readonly displayName: string;
  }[];
}

interface RegistrationSetupLoader {
  load(): Promise<Result<RegistrationSetup>>;
}

export interface RegistrationReplyIntentVerifier {
  isExpectedReply(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly replyToExternalMessageId: string;
    readonly expectedOutboxIdempotencyKey: string;
  }): Promise<boolean>;
}

export interface RegistrationConversationResolverDependencies {
  readonly sessions?: RegistrationConversationSessions;
  readonly registration?: Pick<
    RegistrationService,
    | "getConversation"
    | "getDraft"
    | "resetMutableRegistration"
    | "saveConversationCheckpoint"
    | "submit"
  >;
  readonly community: CommunityContextResolver;
  readonly players: PlayerIdentityResolver;
  readonly setup: RegistrationSetupLoader;
  readonly replyIntent?: RegistrationReplyIntentVerifier;
}

interface PersistedDraftState {
  readonly draft: RegistrationDraftInput;
  readonly revision: number | null;
}

function conversationOutboxKey(context: MessageHandlerContext): string {
  return `${context.idempotencyKey}:registration-conversation`;
}

function replyContext(context: MessageHandlerContext) {
  return {
    externalMessageId: context.message.externalMessageId,
    senderRef: context.message.senderRef,
    text: context.message.text ?? "",
  };
}

function persistedTextResult(
  context: MessageHandlerContext,
  playerId: PlayerId,
  text: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "REGISTRATION_SESSION",
    resultRefId: playerId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text, replyTo: replyContext(context) },
        idempotencyKey: conversationOutboxKey(context),
      },
    ],
  });
}

function persistedTextSequenceResult(
  context: MessageHandlerContext,
  playerId: PlayerId,
  texts: readonly string[],
): Result<MessageHandlerResult> {
  if (texts.length === 0) {
    return err(appError("VALIDATION_FAILED", "Registration text sequence cannot be empty"));
  }
  const baseKey = conversationOutboxKey(context);
  return ok({
    resultRefType: "REGISTRATION_SESSION",
    resultRefId: playerId,
    outgoing: texts.map((text, index) => ({
      channel: "whatsapp" as const,
      destinationRef: context.message.chatRef,
      messageType: "TEXT" as const,
      payload: { text, replyTo: replyContext(context) },
      idempotencyKey: index === texts.length - 1 ? baseKey : `${baseKey}:lead:${String(index + 1)}`,
    })),
  });
}
function persistedSubmissionResult(
  context: MessageHandlerContext,
  playerId: PlayerId,
  review: {
    readonly id: string;
    readonly revision: number;
    readonly snapshot: RegistrationSnapshot;
  },
): Result<MessageHandlerResult> {
  const playerReply = persistedTextResult(
    context,
    playerId,
    [
      "✦ *𝗙𝗜𝗖𝗛𝗔 𝗘𝗡𝗩𝗜𝗔𝗗𝗔*",
      "　Recepção · Aguardando análise",
      "",
      "> _Seu registro foi entregue à equipe responsável._",
      "",
      "A versão enviada ficou preservada enquanto estiver em análise.",
      "",
      "◇ Estado · `EM ANÁLISE`",
      "",
      "_Você será avisado aqui quando houver uma resposta._",
    ].join("\n"),
  );
  if (!playerReply.ok) return playerReply;

  return ok({
    ...playerReply.value,
    outgoing: [
      ...playerReply.value.outgoing,
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text: [
            "▣ *𝗡𝗢𝗩𝗢 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢*",
            "　Recepção · Revisão administrativa",
            "",
            `✦ *${review.snapshot.trainerName}* concluiu sua ficha.`,
            "",
            "› _Responda a esta mensagem com `/verficha` para abrir o registro._",
          ].join("\n"),
          registrationReview: {
            reviewId: review.id,
            reviewRevision: review.revision,
          },
        },
        idempotencyKey: `registration-review-notification:${review.id}:${review.revision}`,
      },
    ],
  });
}

function textResult(
  context: MessageHandlerContext,
  playerId: PlayerId,
  text: string,
  sessions: RegistrationConversationSessions,
  expectsReply: boolean,
): Result<MessageHandlerResult> {
  const idempotencyKey = conversationOutboxKey(context);
  const tracked = expectsReply
    ? sessions.expectReply(playerId, idempotencyKey)
    : sessions.clearExpectedReply(playerId);
  if (!tracked.ok) return tracked;

  return ok({
    resultRefType: "REGISTRATION_SESSION",
    resultRefId: playerId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey,
      },
    ],
  });
}

function starterDisplayNames(setup: RegistrationSetup): readonly string[] {
  return setup.starterOptions.map((option) => option.displayName);
}

function starterDisplayName(starterFormId: string, setup: RegistrationSetup): string {
  return (
    setup.starterOptions.find((option) => option.formId === starterFormId)?.displayName ??
    starterFormId
  );
}

function renderGuidedSessionPrompt(
  session: RegistrationConversationSession,
  setup?: RegistrationSetup,
  modeSelected = false,
): string {
  if (session.currentField === null) {
    return "✅ Ficha preenchida. Use `/ficha` para revisar ou `/confirmar` para conferir o envio. Se quiser continuar depois, use `/salvar`.";
  }

  if (session.currentField === "starterFormId" && setup !== undefined) {
    return renderGuidedField(session.currentField, {
      starterOptions: starterDisplayNames(setup),
      modeSelected,
    });
  }

  return renderGuidedField(session.currentField, modeSelected ? { modeSelected: true } : {});
}

function hasOnboardingCapability(context: CommunityChatContext): boolean {
  return context.known && context.capabilities.includes("onboarding");
}

function isLogicallyAwaitingReply(session: RegistrationConversationSession): boolean {
  if (session.mode === "CHOOSING") return true;
  if (session.mode === "GUIDED") return session.currentField !== null;
  return true;
}

function normalizedFreeform(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
}

function looksLikeCasualNoise(value: string): boolean {
  const normalized = normalizedFreeform(value).replace(/[^a-z0-9]+/g, "");
  return /^(?:k{2,}|ha(?:ha)+|rs+|ok|blz|beleza|sla|sim|nao)$/.test(normalized);
}

function looksLikeGuidedUnquotedAnswer(
  field: PersistedRegistrationConversationField,
  value: string,
): boolean {
  const text = value.trim();
  if (text.length === 0 || looksLikeCasualNoise(text)) return false;
  switch (field) {
    case "age":
      return /^\d{1,3}(?:\s*anos?)?$/iu.test(text);
    case "trainerName":
      return text.length <= 80 && /\p{L}/u.test(text);
    case "genderPronouns":
      return text.length <= 120 && /\p{L}/u.test(text);
    case "appearance":
    case "personality":
    case "backstory":
      return text.length >= 4 && /\p{L}/u.test(text);
    case "starterFormId":
      return /^(?:#?0*\d+|[\p{L}][\p{L}\p{M}' .-]*)$/u.test(text);
  }
  return false;
}

function looksLikePersistedUnquotedIntent(
  conversation: RegistrationConversationRecord,
  text: string,
): boolean {
  switch (conversation.state) {
    case "MODE_SELECT":
      return parseRegistrationModeChoice(text) !== null || looksLikeFullRegistrationTemplate(text);
    case "GUIDED_FIELD":
      return (
        conversation.currentField !== null &&
        looksLikeGuidedUnquotedAnswer(conversation.currentField, text)
      );
    case "FULL_FORM":
      return (
        looksLikeRegistrationTemplate(text) ||
        looksLikeGuidedUnquotedAnswer("starterFormId", text)
      );
    case "REVIEW":
      return ["1", "2", "3"].includes(normalizedChoice(text));
    case "EDIT_SELECT":
      return parseEditFieldChoice(text) !== null;
    case "EDIT_FIELD":
      return (
        conversation.editField !== null &&
        looksLikeGuidedUnquotedAnswer(conversation.editField, text)
      );
    case "RESUME_MENU":
      return ["1", "2", "3"].includes(normalizedChoice(text));
    case "RESTART_CONFIRM":
      return ["1", "2"].includes(normalizedChoice(text));
    case "PAUSED":
    case "SUBMITTED":
      return false;
  }
  return false;
}

function looksLikeSessionUnquotedIntent(
  session: RegistrationConversationSession,
  text: string,
): boolean {
  if (session.mode === "CHOOSING")
    return parseRegistrationModeChoice(text) !== null || looksLikeFullRegistrationTemplate(text);
  if (session.mode === "FULL")
    return (
      looksLikeRegistrationTemplate(text) ||
      looksLikeGuidedUnquotedAnswer("starterFormId", text)
    );
  return session.currentField !== null && looksLikeGuidedUnquotedAnswer(session.currentField, text);
}
function isPersistedStateAwaitingReply(conversation: RegistrationConversationRecord): boolean {
  return (
    conversation.state === "MODE_SELECT" ||
    conversation.state === "GUIDED_FIELD" ||
    conversation.state === "FULL_FORM" ||
    conversation.state === "REVIEW" ||
    conversation.state === "EDIT_SELECT" ||
    conversation.state === "EDIT_FIELD" ||
    conversation.state === "RESUME_MENU" ||
    conversation.state === "RESTART_CONFIRM"
  );
}

function normalizedChoice(value: string): string {
  return normalizeRegistrationChoice(value);
}

function parseEditFieldChoice(
  value: string,
): PersistedRegistrationConversationField | "BACK" | null {
  switch (normalizedChoice(value)) {
    case "1":
      return "trainerName";
    case "2":
      return "age";
    case "3":
      return "genderPronouns";
    case "4":
      return "appearance";
    case "5":
      return "personality";
    case "6":
      return "backstory";
    case "7":
      return "starterFormId";
    case "8":
      return "BACK";
    default:
      return null;
  }
}

const REQUIRED_REGISTRATION_FIELDS: readonly PersistedRegistrationConversationField[] = [
  "trainerName",
  "age",
  "genderPronouns",
  "personality",
  "starterFormId",
];

function missingRequiredFields(
  draft: RegistrationDraftInput,
): PersistedRegistrationConversationField[] {
  return REQUIRED_REGISTRATION_FIELDS.filter((field) => {
    const value = draft[field];
    return value === undefined || (typeof value === "string" && value.trim().length === 0);
  });
}

function looksLikeStandaloneStarter(value: string): boolean {
  return looksLikeGuidedUnquotedAnswer("starterFormId", value);
}

function firstMissingField(
  draft: RegistrationDraftInput,
): PersistedRegistrationConversationField | null {
  for (const field of REGISTRATION_CONVERSATION_FIELDS) {
    const value = draft[field];
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return field;
    }
  }
  return null;
}

function parseGuidedValue(
  field: PersistedRegistrationConversationField,
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

function resolveCanonicalStarterFormId(rawValue: string, setup: RegistrationSetup): Result<string> {
  const value = rawValue.trim();
  const normalized = normalizedChoice(value);

  const numericTokens = [...normalized.matchAll(/(?:^|\s)#?0*(\d+)(?=\s|$)/g)]
    .map((match) => Number(match[1]))
    .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
  const uniqueNumericTokens = [...new Set(numericTokens)];
  if (uniqueNumericTokens.length === 1) {
    const numericChoice = uniqueNumericTokens[0];
    if (numericChoice !== undefined) {
      const option = setup.starterOptions[numericChoice - 1];
      if (option !== undefined) return ok(option.formId);
    }
  }

  const phraseHaystack = ` ${normalized.replace(/[,.!?;:]+/g, " ")} `;
  const matches = setup.starterOptions.filter((option) => {
    const displayName = normalizedChoice(option.displayName);
    return (
      option.formId === value ||
      normalized === displayName ||
      phraseHaystack.includes(` ${displayName} `)
    );
  });

  if (matches.length !== 1) {
    return err(
      appError("VALIDATION_FAILED", "Não consegui identificar esse Pokémon inicial.", {
        fields: ["starterFormId"],
      }),
    );
  }

  const match = matches[0];
  if (match === undefined) {
    return err(appError("VALIDATION_FAILED", "Não consegui identificar esse Pokémon inicial."));
  }
  return ok(match.formId);
}
function reviewText(snapshot: RegistrationSnapshot, setup: RegistrationSetup): string {
  return renderReview({
    trainerName: snapshot.trainerName,
    age: snapshot.age,
    genderPronouns: snapshot.genderPronouns,
    appearance: snapshot.appearance,
    personality: snapshot.personality,
    backstory: snapshot.backstory,
    starterDisplayName: starterDisplayName(snapshot.starterFormId, setup),
    regionDisplayName: setup.regionDisplayName,
  });
}

function draftProgressText(draft: RegistrationDraftInput, setup: RegistrationSetup): string {
  return renderDraftProgress({
    ...(draft.trainerName === undefined ? {} : { trainerName: draft.trainerName }),
    ...(draft.age === undefined ? {} : { age: draft.age }),
    ...(draft.genderPronouns === undefined ? {} : { genderPronouns: draft.genderPronouns }),
    ...(draft.appearance === undefined ? {} : { appearance: draft.appearance }),
    ...(draft.personality === undefined ? {} : { personality: draft.personality }),
    ...(draft.backstory === undefined ? {} : { backstory: draft.backstory }),
    ...(draft.starterFormId === undefined
      ? {}
      : { starterDisplayName: starterDisplayName(draft.starterFormId, setup) }),
    regionDisplayName: setup.regionDisplayName,
  });
}

export class RegistrationConversationResolver {
  public constructor(private readonly dependencies: RegistrationConversationResolverDependencies) {}

  private async hasExpectedReplyIntent(
    message: IncomingMessage,
    session: RegistrationConversationSession,
  ): Promise<boolean> {
    if (!isLogicallyAwaitingReply(session)) return false;
    if (
      session.mode === "FULL" &&
      message.text !== null &&
      looksLikeFullRegistrationTemplate(message.text)
    ) {
      return true;
    }
    const replyToExternalMessageId = message.replyToExternalMessageId;
    if (replyToExternalMessageId === null) {
      return message.text !== null && looksLikeSessionUnquotedIntent(session, message.text);
    }

    const verifier = this.dependencies.replyIntent;
    if (verifier === undefined) return true;

    const expectedOutboxIdempotencyKey = session.expectedReplyOutboxIdempotencyKey;
    if (expectedOutboxIdempotencyKey === null) return false;
    return verifier.isExpectedReply({
      provider: message.provider,
      chatRef: message.chatRef,
      replyToExternalMessageId,
      expectedOutboxIdempotencyKey,
    });
  }

  private async hasPersistedExpectedReplyIntent(
    message: IncomingMessage,
    conversation: RegistrationConversationRecord,
  ): Promise<boolean> {
    if (!isPersistedStateAwaitingReply(conversation)) return false;
    if (conversation.chatRef !== message.chatRef) return false;
    if (
      conversation.state === "FULL_FORM" &&
      message.text !== null &&
      looksLikeFullRegistrationTemplate(message.text)
    ) {
      return true;
    }
    const replyToExternalMessageId = message.replyToExternalMessageId;
    const expectedOutboxIdempotencyKey = conversation.activePromptOutboxIdempotencyKey;
    const verifier = this.dependencies.replyIntent;
    if (replyToExternalMessageId === null) {
      return message.text !== null && looksLikePersistedUnquotedIntent(conversation, message.text);
    }
    if (expectedOutboxIdempotencyKey === null) return false;
    if (verifier === undefined) return true;

    return verifier.isExpectedReply({
      provider: message.provider,
      chatRef: message.chatRef,
      replyToExternalMessageId,
      expectedOutboxIdempotencyKey,
    });
  }

  private async loadPersistedDraft(
    playerId: PlayerId,
    setup: RegistrationSetup,
  ): Promise<Result<PersistedDraftState>> {
    const registration = this.dependencies.registration;
    if (registration === undefined) {
      return err(appError("ACTION_INVALID", "Persisted Registration service is unavailable"));
    }
    const current = await registration.getDraft(playerId);
    if (current.ok) {
      return ok({
        draft: { ...current.value.snapshot, regionId: setup.regionId },
        revision: current.value.revision,
      });
    }
    if (current.error.code !== "NOT_FOUND") return err(current.error);
    return ok({ draft: { regionId: setup.regionId, schemaVersion: 1 }, revision: null });
  }

  private async contextualRetry(
    context: MessageHandlerContext,
    playerId: PlayerId,
    conversation: RegistrationConversationRecord,
    expectedDraftRevision: number | null,
    message: string,
    prompt: string,
  ): Promise<Result<MessageHandlerResult>> {
    const registration = this.dependencies.registration;
    if (registration === undefined) {
      return err(appError("ACTION_INVALID", "Persisted Registration service is unavailable"));
    }
    const saved = await registration.saveConversationCheckpoint({
      playerId,
      chatRef: context.message.chatRef,
      state: conversation.state,
      editingMode: conversation.editingMode,
      currentField: conversation.currentField,
      editField: conversation.editField,
      activePromptOutboxIdempotencyKey: conversationOutboxKey(context),
      expectedConversationRevision: conversation.revision,
      expectedDraftRevision,
      inboxMessageId: context.inboxMessageId,
    });
    if (!saved.ok) return saved;
    return persistedTextResult(context, playerId, renderValidationRetry(message, prompt));
  }

  private async resolvePersistedFullFormInput(
    context: MessageHandlerContext,
    playerId: PlayerId,
    conversation: RegistrationConversationRecord,
    persistedDraft: PersistedDraftState,
    setup: RegistrationSetup,
    text: string,
  ): Promise<Result<MessageHandlerResult>> {
    const registration = this.dependencies.registration;
    if (registration === undefined) {
      return err(appError("ACTION_INVALID", "Persisted Registration service is unavailable"));
    }

    let draft: RegistrationDraftInput = {
      ...persistedDraft.draft,
      regionId: setup.regionId,
      schemaVersion: 1,
    };
    let starterRaw: string | undefined;

    if (looksLikeRegistrationTemplate(text)) {
      const parsed = parsePartialRegistrationTemplate(text);
      if (!parsed.ok) {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "FULL_FORM",
          editingMode: "FULL",
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: conversationOutboxKey(context),
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.revision,
          inboxMessageId: context.inboxMessageId,
          draft,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          renderValidationRetry(
            parsed.error.message,
            renderFullForm({
              regionDisplayName: setup.regionDisplayName,
              starterOptions: starterDisplayNames(setup),
            }),
          ),
        );
      }

      const parsedValue = parsed.value;
      starterRaw = parsedValue.starterFormId;
      draft = {
        ...draft,
        ...(parsedValue.trainerName === undefined
          ? {}
          : { trainerName: parsedValue.trainerName }),
        ...(parsedValue.age === undefined ? {} : { age: parsedValue.age }),
        ...(parsedValue.genderPronouns === undefined
          ? {}
          : { genderPronouns: parsedValue.genderPronouns }),
        ...(parsedValue.appearance === undefined ? {} : { appearance: parsedValue.appearance }),
        ...(parsedValue.personality === undefined
          ? {}
          : { personality: parsedValue.personality }),
        ...(parsedValue.backstory === undefined ? {} : { backstory: parsedValue.backstory }),
      };
    } else if (looksLikeStandaloneStarter(text)) {
      starterRaw = text;
    }

    if (starterRaw !== undefined) {
      const starter = resolveCanonicalStarterFormId(starterRaw, setup);
      if (!starter.ok) {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "FULL_FORM",
          editingMode: "FULL",
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: conversationOutboxKey(context),
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.revision,
          inboxMessageId: context.inboxMessageId,
          draft,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          renderValidationRetry(
            "Não consegui identificar esse Pokémon inicial.",
            renderMissingFullFormFields(["starterFormId"], starterDisplayNames(setup)),
          ),
        );
      }
      draft = { ...draft, starterFormId: starter.value };
    }

    const missing = missingRequiredFields(draft);
    if (missing.length > 0) {
      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "FULL_FORM",
        editingMode: "FULL",
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: conversationOutboxKey(context),
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.revision,
        inboxMessageId: context.inboxMessageId,
        draft,
      });
      if (!saved.ok) return saved;
      return persistedTextResult(
        context,
        playerId,
        renderMissingFullFormFields(missing, starterDisplayNames(setup)),
      );
    }

    const complete = validateRegistrationDraft(draft);
    if (!complete.ok) return complete;
    const saved = await registration.saveConversationCheckpoint({
      playerId,
      chatRef: context.message.chatRef,
      state: "REVIEW",
      editingMode: "FULL",
      currentField: null,
      editField: null,
      activePromptOutboxIdempotencyKey: conversationOutboxKey(context),
      expectedConversationRevision: conversation.revision,
      expectedDraftRevision: persistedDraft.revision,
      inboxMessageId: context.inboxMessageId,
      draft,
    });
    if (!saved.ok) return saved;
    return persistedTextResult(context, playerId, reviewText(complete.value, setup));
  }

  private async resolvePersisted(
    context: MessageHandlerContext,
    playerId: PlayerId,
  ): Promise<Result<MessageHandlerResult | null>> {
    const registration = this.dependencies.registration;
    if (registration === undefined) return ok(null);

    const conversationResult = await registration.getConversation(playerId);
    if (!conversationResult.ok) {
      return conversationResult.error.code === "NOT_FOUND"
        ? ok(null)
        : err(conversationResult.error);
    }
    const conversation = conversationResult.value;
    if (!(await this.hasPersistedExpectedReplyIntent(context.message, conversation))) {
      return ok(null);
    }

    const text = context.message.text;
    if (text === null) return ok(null);
    const setup = await this.dependencies.setup.load();
    if (!setup.ok) return setup;
    const persistedDraft = await this.loadPersistedDraft(playerId, setup.value);
    if (!persistedDraft.ok) return persistedDraft;
    const nextPromptKey = conversationOutboxKey(context);

    if (conversation.state === "MODE_SELECT") {
      const selected = parseRegistrationModeChoice(text);
      if (selected === null) {
        if (looksLikeFullRegistrationTemplate(text)) {
          return this.resolvePersistedFullFormInput(
            context,
            playerId,
            conversation,
            persistedDraft.value,
            setup.value,
            text,
          );
        }
        return this.contextualRetry(
          context,
          playerId,
          conversation,
          persistedDraft.value.revision,
          "Escolha 1 para modo guiado ou 2 para ficha completa.",
          renderModeSelect(),
        );
      }

      if (selected === "GUIDED") {
        const currentField = firstMissingField(persistedDraft.value.draft);
        if (currentField === null) {
          const complete = validateRegistrationDraft(persistedDraft.value.draft);
          if (!complete.ok) return complete;
          const saved = await registration.saveConversationCheckpoint({
            playerId,
            chatRef: context.message.chatRef,
            state: "REVIEW",
            editingMode: "GUIDED",
            currentField: null,
            editField: null,
            activePromptOutboxIdempotencyKey: nextPromptKey,
            expectedConversationRevision: conversation.revision,
            expectedDraftRevision: persistedDraft.value.revision,
            inboxMessageId: context.inboxMessageId,
          });
          if (!saved.ok) return saved;
          return persistedTextResult(context, playerId, reviewText(complete.value, setup.value));
        }

        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "GUIDED_FIELD",
          editingMode: "GUIDED",
          currentField,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          renderGuidedField(
            currentField,
            currentField === "starterFormId"
              ? { starterOptions: starterDisplayNames(setup.value), modeSelected: true }
              : { modeSelected: true },
          ),
        );
      }

      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "FULL_FORM",
        editingMode: "FULL",
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: nextPromptKey,
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.value.revision,
        inboxMessageId: context.inboxMessageId,
      });
      if (!saved.ok) return saved;
      return persistedTextSequenceResult(context, playerId, [
        renderStarterOptions(starterDisplayNames(setup.value)),
        renderFullForm({
          regionDisplayName: setup.value.regionDisplayName,
          starterOptions: starterDisplayNames(setup.value),
        }),
      ]);
    }

    if (conversation.state === "GUIDED_FIELD") {
      const field = conversation.currentField;
      if (field === null) {
        return err(appError("INVALID_STATE_TRANSITION", "Guided registration has no active field"));
      }

      let parsedValue = parseGuidedValue(field, text);
      if (!parsedValue.ok) {
        return this.contextualRetry(
          context,
          playerId,
          conversation,
          persistedDraft.value.revision,
          parsedValue.error.message,
          renderGuidedField(
            field,
            field === "starterFormId" ? { starterOptions: starterDisplayNames(setup.value) } : {},
          ),
        );
      }
      if (field === "starterFormId") {
        const starter = resolveCanonicalStarterFormId(text, setup.value);
        if (!starter.ok) {
          return this.contextualRetry(
            context,
            playerId,
            conversation,
            persistedDraft.value.revision,
            starter.error.message,
            renderGuidedField(field, { starterOptions: starterDisplayNames(setup.value) }),
          );
        }
        parsedValue = ok(starter.value);
      }
      if (!parsedValue.ok) return parsedValue;

      const draft: RegistrationDraftInput = {
        ...persistedDraft.value.draft,
        [field]: parsedValue.value,
        regionId: setup.value.regionId,
        schemaVersion: 1,
      };
      const nextField = firstMissingField(draft);
      const acknowledgementValue =
        field === "starterFormId"
          ? starterDisplayName(String(parsedValue.value), setup.value)
          : parsedValue.value;
      const acknowledgement = renderGuidedAcknowledgement(field, acknowledgementValue);

      if (nextField === null) {
        const complete = validateRegistrationDraft(draft);
        if (!complete.ok) return complete;
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "REVIEW",
          editingMode: "GUIDED",
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
          draft,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          `${acknowledgement}\n\n${reviewText(complete.value, setup.value)}`,
        );
      }

      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "GUIDED_FIELD",
        editingMode: "GUIDED",
        currentField: nextField,
        editField: null,
        activePromptOutboxIdempotencyKey: nextPromptKey,
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.value.revision,
        inboxMessageId: context.inboxMessageId,
        draft,
      });
      if (!saved.ok) return saved;
      const prompt = renderGuidedField(
        nextField,
        nextField === "starterFormId" ? { starterOptions: starterDisplayNames(setup.value) } : {},
      );
      return persistedTextResult(context, playerId, `${acknowledgement}\n\n${prompt}`);
    }

    if (conversation.state === "FULL_FORM") {
      return this.resolvePersistedFullFormInput(
        context,
        playerId,
        conversation,
        persistedDraft.value,
        setup.value,
        text,
      );
    }

    if (conversation.state === "RESUME_MENU") {
      const choice = normalizedChoice(text);

      if (choice === "1") {
        if (conversation.editingMode === "FULL") {
          const saved = await registration.saveConversationCheckpoint({
            playerId,
            chatRef: context.message.chatRef,
            state: "FULL_FORM",
            editingMode: "FULL",
            currentField: null,
            editField: null,
            activePromptOutboxIdempotencyKey: nextPromptKey,
            expectedConversationRevision: conversation.revision,
            expectedDraftRevision: persistedDraft.value.revision,
            inboxMessageId: context.inboxMessageId,
          });
          if (!saved.ok) return saved;
          return persistedTextSequenceResult(context, playerId, [
            renderStarterOptions(starterDisplayNames(setup.value)),
            renderFullForm({
              regionDisplayName: setup.value.regionDisplayName,
              starterOptions: starterDisplayNames(setup.value),
            }),
          ]);
        }

        if (conversation.editingMode !== "GUIDED") {
          return err(
            appError("INVALID_STATE_TRANSITION", "Registration resume has no editing mode"),
          );
        }

        const currentField = firstMissingField(persistedDraft.value.draft);
        if (currentField === null) {
          const complete = validateRegistrationDraft(persistedDraft.value.draft);
          if (!complete.ok) return complete;
          const saved = await registration.saveConversationCheckpoint({
            playerId,
            chatRef: context.message.chatRef,
            state: "REVIEW",
            editingMode: "GUIDED",
            currentField: null,
            editField: null,
            activePromptOutboxIdempotencyKey: nextPromptKey,
            expectedConversationRevision: conversation.revision,
            expectedDraftRevision: persistedDraft.value.revision,
            inboxMessageId: context.inboxMessageId,
          });
          if (!saved.ok) return saved;
          return persistedTextResult(context, playerId, reviewText(complete.value, setup.value));
        }

        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "GUIDED_FIELD",
          editingMode: "GUIDED",
          currentField,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          renderGuidedField(
            currentField,
            currentField === "starterFormId"
              ? { starterOptions: starterDisplayNames(setup.value) }
              : {},
          ),
        );
      }

      if (choice === "2") {
        const complete = validateRegistrationDraft(persistedDraft.value.draft);
        if (complete.ok) {
          const saved = await registration.saveConversationCheckpoint({
            playerId,
            chatRef: context.message.chatRef,
            state: "REVIEW",
            editingMode: conversation.editingMode,
            currentField: null,
            editField: null,
            activePromptOutboxIdempotencyKey: nextPromptKey,
            expectedConversationRevision: conversation.revision,
            expectedDraftRevision: persistedDraft.value.revision,
            inboxMessageId: context.inboxMessageId,
          });
          if (!saved.ok) return saved;
          return persistedTextResult(context, playerId, reviewText(complete.value, setup.value));
        }

        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "RESUME_MENU",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(
          context,
          playerId,
          `${draftProgressText(persistedDraft.value.draft, setup.value)}\n\n${renderResumeMenu()}`,
        );
      }

      if (choice === "3") {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "RESTART_CONFIRM",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, renderRestartConfirm());
      }

      return this.contextualRetry(
        context,
        playerId,
        conversation,
        persistedDraft.value.revision,
        "Escolha 1, 2 ou 3.",
        renderResumeMenu(),
      );
    }

    if (conversation.state === "RESTART_CONFIRM") {
      const choice = normalizedChoice(text);

      if (choice === "2") {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "RESUME_MENU",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, renderResumeMenu());
      }

      if (choice === "1") {
        const reset = await registration.resetMutableRegistration({
          playerId,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
        });
        if (!reset.ok) return reset;

        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "MODE_SELECT",
          editingMode: null,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: null,
          expectedDraftRevision: null,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, renderModeSelect());
      }

      return this.contextualRetry(
        context,
        playerId,
        conversation,
        persistedDraft.value.revision,
        "Escolha 1 para recomeçar ou 2 para cancelar.",
        renderRestartConfirm(),
      );
    }

    if (conversation.state === "REVIEW") {
      const choice = normalizedChoice(text);
      if (choice === "1") {
        const complete = validateRegistrationDraft(persistedDraft.value.draft);
        if (!complete.ok) return complete;

        if (conversation.draftRevision !== persistedDraft.value.revision) {
          const saved = await registration.saveConversationCheckpoint({
            playerId,
            chatRef: context.message.chatRef,
            state: "REVIEW",
            editingMode: conversation.editingMode,
            currentField: null,
            editField: null,
            activePromptOutboxIdempotencyKey: nextPromptKey,
            expectedConversationRevision: conversation.revision,
            expectedDraftRevision: persistedDraft.value.revision,
            inboxMessageId: context.inboxMessageId,
          });
          if (!saved.ok) return saved;
          return persistedTextResult(
            context,
            playerId,
            renderValidationRetry(
              "Sua ficha mudou desde a última revisão. Confira a versão atual antes de enviar.",
              reviewText(complete.value, setup.value),
            ),
          );
        }

        const submitted = await registration.submit({
          playerId,
          idempotencyKey: `${context.idempotencyKey}:registration-submit`,
        });
        if (!submitted.ok) return submitted;

        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "SUBMITTED",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: null,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedSubmissionResult(context, playerId, submitted.value);
      }

      if (choice === "2") {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "EDIT_SELECT",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, renderEditSelect());
      }

      if (choice === "3") {
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "PAUSED",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: null,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, renderPause());
      }

      const complete = validateRegistrationDraft(persistedDraft.value.draft);
      if (!complete.ok) return complete;
      return this.contextualRetry(
        context,
        playerId,
        conversation,
        persistedDraft.value.revision,
        "Escolha 1 para enviar, 2 para corrigir ou 3 para continuar depois.",
        reviewText(complete.value, setup.value),
      );
    }

    if (conversation.state === "EDIT_SELECT") {
      const selected = parseEditFieldChoice(text);
      if (selected === null) {
        return this.contextualRetry(
          context,
          playerId,
          conversation,
          persistedDraft.value.revision,
          "Escolha um campo de 1 a 7 ou 8 para voltar.",
          renderEditSelect(),
        );
      }

      if (selected === "BACK") {
        const complete = validateRegistrationDraft(persistedDraft.value.draft);
        if (!complete.ok) return complete;
        const saved = await registration.saveConversationCheckpoint({
          playerId,
          chatRef: context.message.chatRef,
          state: "REVIEW",
          editingMode: conversation.editingMode,
          currentField: null,
          editField: null,
          activePromptOutboxIdempotencyKey: nextPromptKey,
          expectedConversationRevision: conversation.revision,
          expectedDraftRevision: persistedDraft.value.revision,
          inboxMessageId: context.inboxMessageId,
        });
        if (!saved.ok) return saved;
        return persistedTextResult(context, playerId, reviewText(complete.value, setup.value));
      }

      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "EDIT_FIELD",
        editingMode: conversation.editingMode,
        currentField: null,
        editField: selected,
        activePromptOutboxIdempotencyKey: nextPromptKey,
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.value.revision,
        inboxMessageId: context.inboxMessageId,
      });
      if (!saved.ok) return saved;
      return persistedTextResult(
        context,
        playerId,
        renderEditField(
          selected,
          selected === "starterFormId" ? { starterOptions: starterDisplayNames(setup.value) } : {},
        ),
      );
    }

    if (conversation.state === "EDIT_FIELD") {
      const field = conversation.editField;
      if (field === null) {
        return err(appError("INVALID_STATE_TRANSITION", "Registration edit has no active field"));
      }

      let parsedValue = parseGuidedValue(field, text);
      if (!parsedValue.ok) {
        return this.contextualRetry(
          context,
          playerId,
          conversation,
          persistedDraft.value.revision,
          parsedValue.error.message,
          renderEditField(
            field,
            field === "starterFormId" ? { starterOptions: starterDisplayNames(setup.value) } : {},
          ),
        );
      }
      if (field === "starterFormId") {
        const starter = resolveCanonicalStarterFormId(text, setup.value);
        if (!starter.ok) {
          return this.contextualRetry(
            context,
            playerId,
            conversation,
            persistedDraft.value.revision,
            starter.error.message,
            renderEditField(field, { starterOptions: starterDisplayNames(setup.value) }),
          );
        }
        parsedValue = ok(starter.value);
      }
      if (!parsedValue.ok) return parsedValue;

      const draft: RegistrationDraftInput = {
        ...persistedDraft.value.draft,
        [field]: parsedValue.value,
        regionId: setup.value.regionId,
        schemaVersion: 1,
      };
      const complete = validateRegistrationDraft(draft);
      if (!complete.ok) return complete;
      const acknowledgementValue =
        field === "starterFormId"
          ? starterDisplayName(String(parsedValue.value), setup.value)
          : parsedValue.value;
      const acknowledgement = renderEditAcknowledgement(field, acknowledgementValue);
      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "REVIEW",
        editingMode: conversation.editingMode,
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: nextPromptKey,
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.value.revision,
        inboxMessageId: context.inboxMessageId,
        draft,
      });
      if (!saved.ok) return saved;
      return persistedTextResult(
        context,
        playerId,
        `${acknowledgement}\n\n${reviewText(complete.value, setup.value)}`,
      );
    }

    return ok(null);
  }

  public async admits(message: IncomingMessage): Promise<boolean> {
    const text = message.text;
    if (
      text === null ||
      text.trim().length === 0 ||
      text.trim().startsWith("/") ||
      text.trim().startsWith("$")
    )
      return false;

    const community = await this.dependencies.community.resolveChat({
      provider: message.provider,
      chatRef: message.chatRef,
    });
    if (!hasOnboardingCapability(community)) return false;

    const player = await this.dependencies.players.resolvePlayer({
      provider: message.provider,
      externalId: message.senderRef,
    });
    if (!player.ok) return false;

    if (this.dependencies.registration !== undefined) {
      const conversation = await this.dependencies.registration.getConversation(
        player.value.playerId,
      );
      return conversation.ok
        ? this.hasPersistedExpectedReplyIntent(message, conversation.value)
        : false;
    }

    const sessions = this.dependencies.sessions;
    if (sessions === undefined) return false;
    const active = sessions.get(player.value.playerId);
    if (active === null) return false;
    return this.hasExpectedReplyIntent(message, active);
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const text = context.message.text;
    if (
      text === null ||
      text.trim().length === 0 ||
      text.trim().startsWith("/") ||
      text.trim().startsWith("$")
    )
      return ok(null);

    const community = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!hasOnboardingCapability(community)) return ok(null);

    const player = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) return ok(null);

    if (this.dependencies.registration !== undefined) {
      return this.resolvePersisted(context, player.value.playerId);
    }

    const sessions = this.dependencies.sessions;
    if (sessions === undefined) return ok(null);
    const active = sessions.get(player.value.playerId);
    if (active === null || !(await this.hasExpectedReplyIntent(context.message, active))) {
      return ok(null);
    }

    if (active.mode === "CHOOSING") {
      const chosen = sessions.chooseMode(player.value.playerId, text);
      if (!chosen.ok) return chosen;

      if (chosen.value.mode === "GUIDED") {
        return textResult(
          context,
          player.value.playerId,
          renderGuidedSessionPrompt(chosen.value, undefined, true),
          sessions,
          true,
        );
      }

      const setup = await this.dependencies.setup.load();
      if (!setup.ok) return setup;
      return textResult(
        context,
        player.value.playerId,
        renderFullForm({
          regionDisplayName: setup.value.regionDisplayName,
          starterOptions: starterDisplayNames(setup.value),
        }),
        sessions,
        true,
      );
    }

    if (active.mode === "GUIDED") {
      let answer = text;
      if (active.currentField === "starterFormId") {
        const setup = await this.dependencies.setup.load();
        if (!setup.ok) return setup;
        const starterFormId = resolveCanonicalStarterFormId(text, setup.value);
        if (!starterFormId.ok) return starterFormId;
        answer = starterFormId.value;
      }
      const applied = sessions.applyGuidedAnswer(player.value.playerId, answer);
      if (!applied.ok) return applied;

      if (applied.value.currentField === "starterFormId") {
        const setup = await this.dependencies.setup.load();
        if (!setup.ok) return setup;
        return textResult(
          context,
          player.value.playerId,
          renderGuidedSessionPrompt(applied.value, setup.value),
          sessions,
          true,
        );
      }

      return textResult(
        context,
        player.value.playerId,
        renderGuidedSessionPrompt(applied.value),
        sessions,
        applied.value.currentField !== null,
      );
    }

    const parsed = parseFullRegistrationTemplate(text);
    if (!parsed.ok) return parsed;
    const setup = await this.dependencies.setup.load();
    if (!setup.ok) return setup;
    const starterFormId = resolveCanonicalStarterFormId(parsed.value.starterFormId, setup.value);
    if (!starterFormId.ok) return starterFormId;

    const fields = [
      ["trainerName", parsed.value.trainerName],
      ["age", parsed.value.age],
      ["genderPronouns", parsed.value.genderPronouns],
      ["appearance", parsed.value.appearance],
      ["personality", parsed.value.personality],
      ["backstory", parsed.value.backstory],
      ["starterFormId", starterFormId.value],
    ] as const satisfies readonly (readonly [RegistrationConversationField, string | number])[];

    for (const [field, value] of fields) {
      const applied = sessions.setField(player.value.playerId, field, value);
      if (!applied.ok) return applied;
    }

    return textResult(
      context,
      player.value.playerId,
      "✅ Ficha lida para a sessão atual. Ela ainda não foi enviada nem persistida. Use `/ficha` para revisar, `/salvar` para guardar o rascunho ou `/confirmar` quando quiser conferir o envio.",
      sessions,
      false,
    );
  }
}
