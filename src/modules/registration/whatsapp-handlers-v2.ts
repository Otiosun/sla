import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import {
  REGISTRATION_CONVERSATION_FIELDS,
  type RegistrationConversationEditingMode,
  type RegistrationConversationField,
  type RegistrationConversationRecord,
} from "./conversation-state.js";
import {
  renderDraftProgress,
  renderEditSelect,
  renderFullForm,
  renderGuidedField,
  renderModeSelect,
  renderPause,
  renderResumeMenu,
  renderReview,
} from "./conversation-renderer.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";
import type { RegistrationService } from "./service.js";
import { validateRegistrationDraft } from "./validation.js";

export interface RegistrationStarterOptionV2 {
  readonly formId: string;
  readonly displayName: string;
}

export interface RegistrationSetupV2 {
  readonly regionId: string;
  readonly regionDisplayName: string;
  readonly starterOptions: readonly RegistrationStarterOptionV2[];
}

export interface RegistrationWhatsAppV2Dependencies {
  readonly players: Pick<PlayerRegistrationService, "resolveOrCreatePlayer" | "resolvePlayer">;
  readonly registration: Pick<
    RegistrationService,
    | "getDraft"
    | "getCurrentReview"
    | "getConversation"
    | "saveConversationCheckpoint"
    | "submit"
    | "withdraw"
    | "resetMutableRegistration"
  >;
  readonly setup: { load(): Promise<Result<RegistrationSetupV2>> };
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}

  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

const POLICY = {
  requiredGroupCapabilities: ["onboarding"],
  allowedPlayerAccess: ["PENDING"],
} as const;

function args(context: MessageHandlerContext): readonly string[] {
  return (context.message.text?.trim() ?? "").split(/\s+/).slice(1);
}

function identity(context: MessageHandlerContext) {
  return { provider: context.message.provider, externalId: context.message.senderRef };
}

function commandOutboxKey(context: MessageHandlerContext): string {
  return `${context.idempotencyKey}:registration-command`;
}

function replyContext(context: MessageHandlerContext) {
  return {
    externalMessageId: context.message.externalMessageId,
    senderRef: context.message.senderRef,
    text: context.message.text ?? "",
  };
}

function persistedReply(
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
        idempotencyKey: commandOutboxKey(context),
      },
    ],
  });
}

function parseMode(value: string | undefined): RegistrationConversationEditingMode | null {
  const normalized = (value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");

  if (["1", "guiado", "passo-a-passo", "passo_a_passo", "passo a passo"].includes(normalized)) {
    return "GUIDED";
  }
  if (["2", "completo", "completa", "ficha", "ficha completa"].includes(normalized)) {
    return "FULL";
  }
  return null;
}

function starterDisplayName(starterFormId: string | undefined, setup: RegistrationSetupV2): string {
  if (starterFormId === undefined) return "—";
  return (
    setup.starterOptions.find((option) => option.formId === starterFormId)?.displayName ??
    starterFormId
  );
}

function reviewText(snapshot: RegistrationSnapshot, setup: RegistrationSetupV2): string {
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

function draftText(draft: RegistrationDraftInput, setup: RegistrationSetupV2): string {
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

function firstMissingField(draft: RegistrationDraftInput): RegistrationConversationField | null {
  for (const field of REGISTRATION_CONVERSATION_FIELDS) {
    const current = draft[field];
    if (current === undefined || (typeof current === "string" && current.trim().length === 0)) {
      return field;
    }
  }
  return null;
}

function starterNames(setup: RegistrationSetupV2): readonly string[] {
  return setup.starterOptions.map((option) => option.displayName);
}

async function existingPlayer(
  dependencies: RegistrationWhatsAppV2Dependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

async function loadConversation(
  dependencies: RegistrationWhatsAppV2Dependencies,
  playerId: PlayerId,
): Promise<Result<RegistrationConversationRecord | null>> {
  const conversation = await dependencies.registration.getConversation(playerId);
  if (conversation.ok) return ok(conversation.value);
  return conversation.error.code === "NOT_FOUND" ? ok(null) : err(conversation.error);
}

async function savePromptState(
  dependencies: RegistrationWhatsAppV2Dependencies,
  context: MessageHandlerContext,
  input: {
    readonly playerId: PlayerId;
    readonly conversation: RegistrationConversationRecord | null;
    readonly expectedDraftRevision: number | null;
    readonly state: RegistrationConversationRecord["state"];
    readonly editingMode: RegistrationConversationEditingMode | null;
    readonly currentField?: RegistrationConversationField | null;
    readonly editField?: RegistrationConversationField | null;
    readonly expectsReply: boolean;
  },
) {
  return dependencies.registration.saveConversationCheckpoint({
    playerId: input.playerId,
    chatRef: context.message.chatRef,
    state: input.state,
    editingMode: input.editingMode,
    currentField: input.currentField ?? null,
    editField: input.editField ?? null,
    activePromptOutboxIdempotencyKey: input.expectsReply ? commandOutboxKey(context) : null,
    expectedConversationRevision: input.conversation?.revision ?? null,
    expectedDraftRevision: input.expectedDraftRevision,
    inboxMessageId: context.inboxMessageId,
  });
}

async function resumeDraft(
  dependencies: RegistrationWhatsAppV2Dependencies,
  context: MessageHandlerContext,
  playerId: PlayerId,
): Promise<Result<MessageHandlerResult>> {
  const setup = await dependencies.setup.load();
  if (!setup.ok) return setup;

  const draft = await dependencies.registration.getDraft(playerId);
  if (!draft.ok) {
    return err(
      draft.error.code === "NOT_FOUND"
        ? appError("NOT_FOUND", "Nenhum rascunho salvo. Use `$registrar` para começar.")
        : draft.error,
    );
  }

  const conversation = await loadConversation(dependencies, playerId);
  if (!conversation.ok) return conversation;

  const complete = validateRegistrationDraft(draft.value.snapshot);
  if (complete.ok) {
    const saved = await savePromptState(dependencies, context, {
      playerId,
      conversation: conversation.value,
      expectedDraftRevision: draft.value.revision,
      state: "REVIEW",
      editingMode: conversation.value?.editingMode ?? "GUIDED",
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(context, playerId, reviewText(complete.value, setup.value));
  }

  if (conversation.value?.editingMode === "FULL") {
    const saved = await savePromptState(dependencies, context, {
      playerId,
      conversation: conversation.value,
      expectedDraftRevision: draft.value.revision,
      state: "FULL_FORM",
      editingMode: "FULL",
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(
      context,
      playerId,
      renderFullForm({
        regionDisplayName: setup.value.regionDisplayName,
        starterOptions: starterNames(setup.value),
      }),
    );
  }

  const currentField = firstMissingField(draft.value.snapshot);
  if (currentField === null) {
    return err(appError("INVALID_STATE_TRANSITION", "Registration draft cannot be resumed"));
  }

  const saved = await savePromptState(dependencies, context, {
    playerId,
    conversation: conversation.value,
    expectedDraftRevision: draft.value.revision,
    state: "GUIDED_FIELD",
    editingMode: "GUIDED",
    currentField,
    expectsReply: true,
  });
  if (!saved.ok) return saved;

  return persistedReply(
    context,
    playerId,
    renderGuidedField(
      currentField,
      currentField === "starterFormId"
        ? { starterOptions: starterNames(setup.value) }
        : {},
    ),
  );
}

export function createRegistrationWhatsAppRoutesV2(
  dependencies: RegistrationWhatsAppV2Dependencies,
): readonly CommandRouteDefinition[] {
  const register: Handler = async (context) => {
    const player = await dependencies.players.resolveOrCreatePlayer(identity(context));
    if (!player.ok) return player;

    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;

    const conversation = await loadConversation(dependencies, player.value.playerId);
    if (!conversation.ok) return conversation;

    const draft = await dependencies.registration.getDraft(player.value.playerId);
    if (!draft.ok && draft.error.code !== "NOT_FOUND") return draft;

    const review = await dependencies.registration.getCurrentReview(player.value.playerId);
    if (!review.ok && review.error.code !== "NOT_FOUND") return review;

    const draftRevision = draft.ok ? draft.value.revision : null;
    const editingMode = conversation.value?.editingMode ?? "GUIDED";

    if (
      review.ok &&
      (review.value.status === "SUBMITTED" ||
        review.value.status === "APPROVED" ||
        review.value.status === "REJECTED")
    ) {
      const saved = await savePromptState(dependencies, context, {
        playerId: player.value.playerId,
        conversation: conversation.value,
        expectedDraftRevision: draftRevision,
        state: "SUBMITTED",
        editingMode,
        expectsReply: false,
      });
      if (!saved.ok) return saved;

      if (review.value.status === "SUBMITTED") {
        return persistedReply(
          context,
          player.value.playerId,
          "📨 Sua ficha já foi enviada e está em análise pela equipe.",
        );
      }
      if (review.value.status === "APPROVED") {
        return persistedReply(
          context,
          player.value.playerId,
          "✅ Sua ficha já foi aprovada. Seu cadastro de treinador está concluído.",
        );
      }
      return persistedReply(
        context,
        player.value.playerId,
        "⛔ Sua ficha foi rejeitada. Fale com a equipe da Recepção antes de iniciar outra revisão.",
      );
    }

    if (draft.ok) {
      const complete = validateRegistrationDraft(draft.value.snapshot);
      if (complete.ok) {
        const saved = await savePromptState(dependencies, context, {
          playerId: player.value.playerId,
          conversation: conversation.value,
          expectedDraftRevision: draft.value.revision,
          state: "REVIEW",
          editingMode,
          expectsReply: true,
        });
        if (!saved.ok) return saved;
        return persistedReply(
          context,
          player.value.playerId,
          reviewText(complete.value, setup.value),
        );
      }

      const saved = await savePromptState(dependencies, context, {
        playerId: player.value.playerId,
        conversation: conversation.value,
        expectedDraftRevision: draft.value.revision,
        state: "RESUME_MENU",
        editingMode,
        expectsReply: true,
      });
      if (!saved.ok) return saved;
      return persistedReply(context, player.value.playerId, renderResumeMenu());
    }

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value.playerId,
      conversation: conversation.value,
      expectedDraftRevision: null,
      state: "MODE_SELECT",
      editingMode: null,
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(context, player.value.playerId, renderModeSelect());
  };

  const mode: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;

    const selected = parseMode(args(context).join(" "));
    if (selected === null) {
      return err(appError("VALIDATION_FAILED", "Use `$modo guiado` ou `$modo completo`."));
    }

    const conversation = await loadConversation(dependencies, player.value);
    if (!conversation.ok) return conversation;
    if (conversation.value === null) {
      return err(appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."));
    }

    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;
    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok && draft.error.code !== "NOT_FOUND") return draft;
    const draftRevision = draft.ok ? draft.value.revision : null;
    const snapshot: RegistrationDraftInput = draft.ok
      ? { ...draft.value.snapshot, regionId: setup.value.regionId }
      : { regionId: setup.value.regionId, schemaVersion: 1 };

    if (selected === "FULL") {
      const saved = await savePromptState(dependencies, context, {
        playerId: player.value,
        conversation: conversation.value,
        expectedDraftRevision: draftRevision,
        state: "FULL_FORM",
        editingMode: "FULL",
        expectsReply: true,
      });
      if (!saved.ok) return saved;
      return persistedReply(
        context,
        player.value,
        renderFullForm({
          regionDisplayName: setup.value.regionDisplayName,
          starterOptions: starterNames(setup.value),
        }),
      );
    }

    const currentField = firstMissingField(snapshot);
    if (currentField === null) {
      const complete = validateRegistrationDraft(snapshot);
      if (!complete.ok) return complete;
      const saved = await savePromptState(dependencies, context, {
        playerId: player.value,
        conversation: conversation.value,
        expectedDraftRevision: draftRevision,
        state: "REVIEW",
        editingMode: "GUIDED",
        expectsReply: true,
      });
      if (!saved.ok) return saved;
      return persistedReply(context, player.value, reviewText(complete.value, setup.value));
    }

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value,
      conversation: conversation.value,
      expectedDraftRevision: draftRevision,
      state: "GUIDED_FIELD",
      editingMode: "GUIDED",
      currentField,
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(
      context,
      player.value,
      renderGuidedField(
        currentField,
        currentField === "starterFormId"
          ? { starterOptions: starterNames(setup.value) }
          : {},
      ),
    );
  };

  const ficha: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;

    const conversation = await loadConversation(dependencies, player.value);
    if (!conversation.ok) return conversation;
    if (conversation.value === null) {
      return err(appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."));
    }

    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok) return draft;
    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;

    const complete = validateRegistrationDraft(draft.value.snapshot);
    if (!complete.ok) {
      return persistedReply(context, player.value, draftText(draft.value.snapshot, setup.value));
    }

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value,
      conversation: conversation.value,
      expectedDraftRevision: draft.value.revision,
      state: "REVIEW",
      editingMode: conversation.value.editingMode ?? "GUIDED",
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(context, player.value, reviewText(complete.value, setup.value));
  };

  const save: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;

    const conversation = await loadConversation(dependencies, player.value);
    if (!conversation.ok) return conversation;
    if (conversation.value === null) {
      return err(appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."));
    }

    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok && draft.error.code !== "NOT_FOUND") return draft;

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value,
      conversation: conversation.value,
      expectedDraftRevision: draft.ok ? draft.value.revision : null,
      state: "PAUSED",
      editingMode: conversation.value.editingMode ?? "GUIDED",
      expectsReply: false,
    });
    if (!saved.ok) return saved;
    return persistedReply(context, player.value, renderPause());
  };

  const continueDraft: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    return resumeDraft(dependencies, context, player.value);
  };

  const edit: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;

    const editArg = args(context)[0]?.toLocaleLowerCase("pt-BR");
    if (editArg !== undefined && editArg !== "sim") {
      return err(appError("VALIDATION_FAILED", "Use `$editar` ou `$editar sim`."));
    }

    const conversation = await loadConversation(dependencies, player.value);
    if (!conversation.ok) return conversation;
    if (conversation.value === null) {
      return err(appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."));
    }

    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok) return draft;
    const review = await dependencies.registration.getCurrentReview(player.value);

    if (editArg === "sim") {
      if (
        conversation.value.state !== "WITHDRAW_CONFIRM" ||
        conversation.value.pendingReviewId === null ||
        conversation.value.pendingReviewId === undefined ||
        conversation.value.pendingReviewRevision === null ||
        conversation.value.pendingReviewRevision === undefined
      ) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Nenhuma retirada de revisão está aguardando confirmação.",
          ),
        );
      }
      if (
        !review.ok ||
        review.value.status !== "SUBMITTED" ||
        review.value.id !== conversation.value.pendingReviewId ||
        review.value.revision !== conversation.value.pendingReviewRevision
      ) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "A revisão em análise mudou. Use `$editar` novamente antes de retirar.",
          ),
        );
      }

      const withdrawn = await dependencies.registration.withdraw({
        playerId: player.value,
        revisionId: conversation.value.pendingReviewId,
        expectedRevision: conversation.value.pendingReviewRevision,
      });
      if (!withdrawn.ok) return withdrawn;

      const saved = await dependencies.registration.saveConversationCheckpoint({
        playerId: player.value,
        chatRef: context.message.chatRef,
        state: "EDIT_SELECT",
        editingMode: conversation.value.editingMode ?? "GUIDED",
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: commandOutboxKey(context),
        pendingReviewId: null,
        pendingReviewRevision: null,
        expectedConversationRevision: conversation.value.revision,
        expectedDraftRevision: draft.value.revision,
        inboxMessageId: context.inboxMessageId,
      });
      if (!saved.ok) return saved;
      return persistedReply(context, player.value, renderEditSelect());
    }

    if (!review.ok) {
      if (review.error.code !== "NOT_FOUND") return review;
      const saved = await savePromptState(dependencies, context, {
        playerId: player.value,
        conversation: conversation.value,
        expectedDraftRevision: draft.value.revision,
        state: "EDIT_SELECT",
        editingMode: conversation.value.editingMode ?? "GUIDED",
        expectsReply: true,
      });
      if (!saved.ok) return saved;
      return persistedReply(context, player.value, renderEditSelect());
    }

    if (review.value.status === "SUBMITTED") {
      const saved = await dependencies.registration.saveConversationCheckpoint({
        playerId: player.value,
        chatRef: context.message.chatRef,
        state: "WITHDRAW_CONFIRM",
        editingMode: conversation.value.editingMode ?? "GUIDED",
        currentField: null,
        editField: null,
        activePromptOutboxIdempotencyKey: null,
        pendingReviewId: review.value.id,
        pendingReviewRevision: review.value.revision,
        expectedConversationRevision: conversation.value.revision,
        expectedDraftRevision: draft.value.revision,
        inboxMessageId: context.inboxMessageId,
      });
      if (!saved.ok) return saved;
      return persistedReply(
        context,
        player.value,
        "⚠️ Sua ficha está em análise. Para retirar a revisão atual e abrir a edição, use `$editar sim`.",
      );
    }

    if (review.value.status !== "CHANGES_REQUESTED" && review.value.status !== "WITHDRAWN") {
      return err(
        appError(
          "INVALID_STATE_TRANSITION",
          "Esta revisão não pode ser reaberta para edição neste estado.",
        ),
      );
    }

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value,
      conversation: conversation.value,
      expectedDraftRevision: draft.value.revision,
      state: "EDIT_SELECT",
      editingMode: conversation.value.editingMode ?? "GUIDED",
      expectsReply: true,
    });
    if (!saved.ok) return saved;
    return persistedReply(context, player.value, renderEditSelect());
  };

  const confirm: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;

    const confirmationArg = args(context)[0]?.toLocaleLowerCase("pt-BR");
    if (confirmationArg !== undefined && confirmationArg !== "sim") {
      return err(appError("VALIDATION_FAILED", "Use `$confirmar` ou `$confirmar sim`."));
    }

    const conversation = await loadConversation(dependencies, player.value);
    if (!conversation.ok) return conversation;
    if (conversation.value === null) {
      return err(appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."));
    }

    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok) return draft;
    const validation = validateRegistrationDraft(draft.value.snapshot);
    if (!validation.ok) return validation;
    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;

    if (confirmationArg === undefined) {
      const saved = await savePromptState(dependencies, context, {
        playerId: player.value,
        conversation: conversation.value,
        expectedDraftRevision: draft.value.revision,
        state: "REVIEW",
        editingMode: conversation.value.editingMode ?? "GUIDED",
        expectsReply: true,
      });
      if (!saved.ok) return saved;
      return persistedReply(context, player.value, reviewText(validation.value, setup.value));
    }

    if (
      conversation.value.state !== "REVIEW" ||
      conversation.value.draftRevision !== draft.value.revision
    ) {
      return err(
        appError(
          "INVALID_STATE_TRANSITION",
          "A ficha atual mudou ou ainda não foi revisada. Use `$confirmar` novamente antes de enviar.",
        ),
      );
    }

    const submitted = await dependencies.registration.submit({
      playerId: player.value,
      idempotencyKey: `${context.idempotencyKey}:registration-submit`,
    });
    if (!submitted.ok) return submitted;

    const saved = await savePromptState(dependencies, context, {
      playerId: player.value,
      conversation: conversation.value,
      expectedDraftRevision: draft.value.revision,
      state: "SUBMITTED",
      editingMode: conversation.value.editingMode ?? "GUIDED",
      expectsReply: false,
    });
    if (!saved.ok) return saved;

    const playerReply = persistedReply(
      context,
      player.value,
      "📨 Ficha enviada para análise da equipe. Ela ficou congelada nesta revisão.",
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
            text: `📋 Nova ficha de ${submitted.value.snapshot.trainerName} aguardando revisão. Responda a esta mensagem para revisar a ficha.`,
            registrationReview: {
              reviewId: submitted.value.id,
              reviewRevision: submitted.value.revision,
            },
          },
          idempotencyKey: `registration-review-notification:${submitted.value.id}:${submitted.value.revision}`,
        },
      ],
    });
  };

  return [
    { command: "registrar", handler: new FunctionalHandler(register), policy: POLICY },
    { command: "modo", handler: new FunctionalHandler(mode), policy: POLICY },
    { command: "ficha", handler: new FunctionalHandler(ficha), policy: POLICY },
    { command: "salvar", handler: new FunctionalHandler(save), policy: POLICY },
    { command: "continuar", handler: new FunctionalHandler(continueDraft), policy: POLICY },
    { command: "editar", handler: new FunctionalHandler(edit), policy: POLICY },
    { command: "confirmar", handler: new FunctionalHandler(confirm), policy: POLICY },
  ];
}
