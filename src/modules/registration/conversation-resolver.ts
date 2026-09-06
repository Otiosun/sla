import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CommunityChatContext } from "../community/contracts.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import {
  REGISTRATION_CONVERSATION_FIELDS,
  type RegistrationConversationField as PersistedRegistrationConversationField,
  type RegistrationConversationRecord,
} from "./conversation-state.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";
import {
  renderFullForm,
  renderGuidedAcknowledgement,
  renderGuidedField,
  renderReview,
  renderValidationRetry,
} from "./conversation-renderer.js";
import {
  type RegistrationConversationField,
  type RegistrationConversationSession,
  type RegistrationConversationSessions,
  parseFullRegistrationTemplate,
} from "./conversation-session.js";
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
    "getConversation" | "getDraft" | "saveConversationCheckpoint"
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
    return "✅ Ficha preenchida. Use `$ficha` para revisar ou `$confirmar` para conferir o envio. Se quiser continuar depois, use `$salvar`.";
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

function isPersistedStateHandledByTask4(conversation: RegistrationConversationRecord): boolean {
  return (
    conversation.state === "MODE_SELECT" ||
    conversation.state === "GUIDED_FIELD" ||
    conversation.state === "FULL_FORM"
  );
}

function normalizedChoice(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
}

function parsePersistedModeChoice(value: string): "GUIDED" | "FULL" | null {
  switch (normalizedChoice(value)) {
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
  if (/^[1-9]\d*$/.test(value)) {
    const index = Number(value);
    if (Number.isSafeInteger(index)) {
      const option = setup.starterOptions[index - 1];
      if (option !== undefined) return ok(option.formId);
    }
  }

  const normalized = normalizedChoice(value);
  const matches = setup.starterOptions.filter(
    (option) => option.formId === value || normalizedChoice(option.displayName) === normalized,
  );
  if (matches.length !== 1) {
    return err(
      appError("VALIDATION_FAILED", "Pokémon inicial inválido ou ambíguo", {
        fields: ["starterFormId"],
      }),
    );
  }
  const match = matches[0];
  if (match === undefined) {
    return err(
      appError("VALIDATION_FAILED", "Pokémon inicial inválido ou ambíguo", {
        fields: ["starterFormId"],
      }),
    );
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

export class RegistrationConversationResolver {
  public constructor(private readonly dependencies: RegistrationConversationResolverDependencies) {}

  private async hasExpectedReplyIntent(
    message: IncomingMessage,
    session: RegistrationConversationSession,
  ): Promise<boolean> {
    if (!isLogicallyAwaitingReply(session)) return false;
    const replyToExternalMessageId = message.replyToExternalMessageId;
    if (replyToExternalMessageId === null) return false;

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
    if (!isPersistedStateHandledByTask4(conversation)) return false;
    if (conversation.chatRef !== message.chatRef) return false;
    const replyToExternalMessageId = message.replyToExternalMessageId;
    const expectedOutboxIdempotencyKey = conversation.activePromptOutboxIdempotencyKey;
    const verifier = this.dependencies.replyIntent;
    if (
      replyToExternalMessageId === null ||
      expectedOutboxIdempotencyKey === null ||
      verifier === undefined
    ) {
      return false;
    }

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
    if (!(await this.hasPersistedExpectedReplyIntent(context.message, conversation)))
      return ok(null);

    const text = context.message.text;
    if (text === null) return ok(null);
    const setup = await this.dependencies.setup.load();
    if (!setup.ok) return setup;
    const persistedDraft = await this.loadPersistedDraft(playerId, setup.value);
    if (!persistedDraft.ok) return persistedDraft;
    const nextPromptKey = conversationOutboxKey(context);

    if (conversation.state === "MODE_SELECT") {
      const selected = parsePersistedModeChoice(text);
      if (selected === null) {
        return err(
          appError("VALIDATION_FAILED", "Escolha 1 para modo guiado ou 2 para ficha completa"),
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
      return persistedTextResult(
        context,
        playerId,
        renderFullForm({
          regionDisplayName: setup.value.regionDisplayName,
          starterOptions: starterDisplayNames(setup.value),
        }),
      );
    }

    if (conversation.state === "GUIDED_FIELD") {
      const field = conversation.currentField;
      if (field === null) {
        return err(appError("INVALID_STATE_TRANSITION", "Guided registration has no active field"));
      }

      let parsedValue = parseGuidedValue(field, text);
      if (!parsedValue.ok) return parsedValue;
      if (field === "starterFormId") {
        const starter = resolveCanonicalStarterFormId(text, setup.value);
        if (!starter.ok) return starter;
        parsedValue = ok(starter.value);
      }

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
      const fullPrompt = renderFullForm({
        regionDisplayName: setup.value.regionDisplayName,
        starterOptions: starterDisplayNames(setup.value),
      });
      const parsed = parseFullRegistrationTemplate(text);
      if (!parsed.ok) {
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
        return persistedTextResult(
          context,
          playerId,
          renderValidationRetry("Confira os campos da ficha e tente novamente.", fullPrompt),
        );
      }

      const starter = resolveCanonicalStarterFormId(parsed.value.starterFormId, setup.value);
      if (!starter.ok) {
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
        return persistedTextResult(
          context,
          playerId,
          renderValidationRetry("Escolha um Pokémon inicial válido.", fullPrompt),
        );
      }

      const draft: RegistrationDraftInput = {
        trainerName: parsed.value.trainerName,
        age: parsed.value.age,
        genderPronouns: parsed.value.genderPronouns,
        appearance: parsed.value.appearance,
        personality: parsed.value.personality,
        backstory: parsed.value.backstory,
        starterFormId: starter.value,
        regionId: setup.value.regionId,
        schemaVersion: 1,
      };
      const complete = validateRegistrationDraft(draft);
      if (!complete.ok) return complete;
      const saved = await registration.saveConversationCheckpoint({
        playerId,
        chatRef: context.message.chatRef,
        state: "REVIEW",
        editingMode: "FULL",
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: nextPromptKey,
        expectedConversationRevision: conversation.revision,
        expectedDraftRevision: persistedDraft.value.revision,
        inboxMessageId: context.inboxMessageId,
        draft,
      });
      if (!saved.ok) return saved;
      return persistedTextResult(context, playerId, reviewText(complete.value, setup.value));
    }

    return ok(null);
  }

  public async admits(message: IncomingMessage): Promise<boolean> {
    const text = message.text;
    if (text === null || text.trim().length === 0 || text.trim().startsWith("$")) return false;

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
    if (text === null || text.trim().length === 0 || text.trim().startsWith("$")) return ok(null);

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
      "✅ Ficha lida para a sessão atual. Ela ainda não foi enviada nem persistida. Use `$ficha` para revisar, `$salvar` para guardar o rascunho ou `$confirmar` quando quiser conferir o envio.",
      sessions,
      false,
    );
  }
}
