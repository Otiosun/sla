import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type {
  RegistrationConversationField,
  RegistrationConversationSession,
  RegistrationConversationSessions,
  RegistrationEditingMode,
} from "./conversation-session.js";
import type { RegistrationService } from "./service.js";
import { validateRegistrationDraft } from "./validation.js";

export interface RegistrationStarterOption {
  readonly formId: string;
  readonly displayName: string;
}

export interface RegistrationSetup {
  readonly regionId: string;
  readonly regionDisplayName: string;
  readonly starterOptions: readonly RegistrationStarterOption[];
}

export interface RegistrationWhatsAppDependencies {
  readonly sessions: RegistrationConversationSessions;
  readonly players: Pick<PlayerRegistrationService, "resolveOrCreatePlayer" | "resolvePlayer">;
  readonly registration: Pick<
    RegistrationService,
    "getDraft" | "getCurrentReview" | "saveDraft" | "saveAndSubmit" | "withdraw"
  >;
  readonly setup: { load(): Promise<Result<RegistrationSetup>> };
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

const LABELS: Readonly<Record<RegistrationConversationField, string>> = {
  trainerName: "Nome do treinador",
  age: "Idade",
  genderPronouns: "Gênero / pronomes",
  appearance: "Aparência",
  personality: "Personalidade",
  backstory: "História / resumo",
  starterFormId: "Pokémon inicial",
};

function args(context: MessageHandlerContext): readonly string[] {
  return (context.message.text?.trim() ?? "").split(/\s+/).slice(1);
}

function identity(context: MessageHandlerContext) {
  return { provider: context.message.provider, externalId: context.message.senderRef };
}

function reply(
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
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:registration-command`,
      },
    ],
  });
}

function parseMode(value: string | undefined): RegistrationEditingMode | null {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
  if (["1", "guiado", "passo-a-passo", "passo_a_passo"].includes(normalized)) return "GUIDED";
  if (["2", "completo", "completa", "ficha"].includes(normalized)) return "FULL";
  return null;
}

function guidedPrompt(session: RegistrationConversationSession): string {
  return session.currentField === null
    ? "✅ Todos os campos atuais estão preenchidos. Use `$ficha` para revisar."
    : `📝 *${LABELS[session.currentField]}*\n\nEnvie sua resposta.`;
}

function fullTemplate(setup: RegistrationSetup): string {
  return [
    "📋 *FICHA COMPLETA*",
    "",
    "Nome:",
    "Idade:",
    "Gênero / pronomes:",
    "Aparência:",
    "Personalidade:",
    "História / resumo:",
    "Pokémon inicial:",
    "",
    `Região: ${setup.regionDisplayName}`,
    "",
    "Envie a ficha preenchida. Nada é definitivo nesta etapa.",
  ].join("\n");
}

function value(value: string | number | undefined): string {
  return value === undefined || String(value).trim().length === 0 ? "—" : String(value);
}

function starterDisplayName(starterFormId: string | undefined, setup: RegistrationSetup): string {
  if (starterFormId === undefined) return "—";
  return (
    setup.starterOptions.find((option) => option.formId === starterFormId)?.displayName ??
    starterFormId
  );
}

function fichaText(session: RegistrationConversationSession, setup: RegistrationSetup): string {
  return [
    "📋 *FICHA ATUAL*",
    "",
    `Nome: ${value(session.working.trainerName)}`,
    `Idade: ${value(session.working.age)}`,
    `Gênero / pronomes: ${value(session.working.genderPronouns)}`,
    `Aparência: ${value(session.working.appearance)}`,
    `Personalidade: ${value(session.working.personality)}`,
    `História / resumo: ${value(session.working.backstory)}`,
    `Pokémon inicial: ${starterDisplayName(session.working.starterFormId, setup)}`,
    `Região: ${setup.regionDisplayName}`,
    "",
    session.dirty
      ? "⚠️ Existem alterações não salvas."
      : "Nenhuma alteração não salva nesta sessão.",
  ].join("\n");
}

function confirmationText(
  session: RegistrationConversationSession,
  setup: RegistrationSetup,
): string {
  return [
    "✅ *CONFIRMAÇÃO DA FICHA*",
    "",
    `Nome: ${value(session.working.trainerName)}`,
    `Idade: ${value(session.working.age)}`,
    `Gênero / pronomes: ${value(session.working.genderPronouns)}`,
    `Aparência: ${value(session.working.appearance)}`,
    `Personalidade: ${value(session.working.personality)}`,
    `História / resumo: ${value(session.working.backstory)}`,
    `Pokémon inicial: ${starterDisplayName(session.working.starterFormId, setup)}`,
    `Região: ${setup.regionDisplayName}`,
    "",
    "Confira tudo acima. Nada foi enviado ainda.",
    "Se estiver correto, use `$confirmar sim`.",
  ].join("\n");
}

function confirmationFingerprint(session: RegistrationConversationSession): string {
  return JSON.stringify({
    persistedRevision: session.persistedRevision,
    trainerName: session.working.trainerName,
    age: session.working.age,
    genderPronouns: session.working.genderPronouns,
    appearance: session.working.appearance,
    personality: session.working.personality,
    backstory: session.working.backstory,
    starterFormId: session.working.starterFormId,
    regionId: session.working.regionId,
    schemaVersion: session.working.schemaVersion,
  });
}

async function existingPlayer(
  dependencies: RegistrationWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

async function openPersistedDraft(
  dependencies: RegistrationWhatsAppDependencies,
  context: MessageHandlerContext,
  playerId: PlayerId,
): Promise<Result<MessageHandlerResult>> {
  const draft = await dependencies.registration.getDraft(playerId);
  if (!draft.ok) {
    return err(
      draft.error.code === "NOT_FOUND"
        ? appError("NOT_FOUND", "Nenhum rascunho salvo para editar.")
        : draft.error,
    );
  }

  const resumed = dependencies.sessions.start(playerId, {
    mode: "GUIDED",
    regionId: draft.value.snapshot.regionId,
    baseDraft: draft.value.snapshot,
    baseRevision: draft.value.revision,
  });
  return reply(context, playerId, `✏️ Edição aberta.\n\n${guidedPrompt(resumed)}`);
}

export function createRegistrationWhatsAppRoutes(
  dependencies: RegistrationWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const pendingConfirmations = new Map<PlayerId, string>();
  const pendingWithdrawals = new Map<
    PlayerId,
    { readonly reviewId: string; readonly revision: number }
  >();

  const register: Handler = async (context) => {
    const player = await dependencies.players.resolveOrCreatePlayer(identity(context));
    if (!player.ok) return player;
    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;
    pendingConfirmations.delete(player.value.playerId);
    pendingWithdrawals.delete(player.value.playerId);
    dependencies.sessions.begin(player.value.playerId, { regionId: setup.value.regionId });
    return reply(
      context,
      player.value.playerId,
      [
        "🎒 *CRIAÇÃO DE TREINADOR*",
        "",
        "Como prefere montar sua ficha?",
        "1. Quero ser guiado passo a passo",
        "2. Quero preencher a ficha completa",
        "",
        "Responda `1` ou `2`. Nada será definido só por começar o cadastro.",
      ].join("\n"),
    );
  };

  const mode: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const selected = parseMode(args(context)[0]);
    if (selected === null) {
      return err(appError("VALIDATION_FAILED", "Use `$modo guiado` ou `$modo completo`."));
    }
    pendingConfirmations.delete(player.value);
    pendingWithdrawals.delete(player.value);
    const switched = dependencies.sessions.switchMode(player.value, selected);
    if (!switched.ok) return switched;
    if (selected === "GUIDED") return reply(context, player.value, guidedPrompt(switched.value));
    const setup = await dependencies.setup.load();
    return setup.ok ? reply(context, player.value, fullTemplate(setup.value)) : setup;
  };

  const ficha: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const session = dependencies.sessions.get(player.value);
    if (session === null) {
      return err(
        appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."),
      );
    }
    const setup = await dependencies.setup.load();
    return setup.ok ? reply(context, player.value, fichaText(session, setup.value)) : setup;
  };

  const save: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const session = dependencies.sessions.get(player.value);
    if (session === null) {
      return err(
        appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."),
      );
    }
    if (session.mode === "CHOOSING") {
      return err(appError("INVALID_STATE_TRANSITION", "Escolha o modo da ficha antes de salvar."));
    }

    pendingConfirmations.delete(player.value);
    pendingWithdrawals.delete(player.value);
    const saved = await dependencies.registration.saveDraft({
      playerId: player.value,
      draft: session.working,
      expectedRevision: session.persistedRevision,
    });
    if (!saved.ok) return saved;

    const clean = dependencies.sessions.start(player.value, {
      mode: session.mode,
      regionId: saved.value.snapshot.regionId,
      baseDraft: saved.value.snapshot,
      baseRevision: saved.value.revision,
    });
    return reply(
      context,
      player.value,
      `💾 Rascunho salvo.\n\n${clean.mode === "GUIDED" ? guidedPrompt(clean) : "Use `$ficha` para revisar ou continue editando."}`,
    );
  };

  const continueDraft: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok) {
      return err(
        draft.error.code === "NOT_FOUND"
          ? appError("NOT_FOUND", "Nenhum rascunho salvo. Use `$registrar` para começar.")
          : draft.error,
      );
    }
    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;

    pendingConfirmations.delete(player.value);
    pendingWithdrawals.delete(player.value);
    const resumed = dependencies.sessions.start(player.value, {
      mode: "GUIDED",
      regionId: setup.value.regionId,
      baseDraft: draft.value.snapshot,
      baseRevision: draft.value.revision,
    });
    return reply(context, player.value, `↩️ Rascunho retomado.\n\n${guidedPrompt(resumed)}`);
  };

  const edit: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    pendingConfirmations.delete(player.value);

    const editArg = args(context)[0]?.toLocaleLowerCase("pt-BR");
    if (editArg !== undefined && editArg !== "sim") {
      return err(appError("VALIDATION_FAILED", "Use `$editar` ou `$editar sim`."));
    }

    if (editArg === "sim") {
      const pending = pendingWithdrawals.get(player.value);
      if (pending === undefined) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Nenhuma retirada de revisão está aguardando confirmação.",
          ),
        );
      }

      const current = await dependencies.registration.getCurrentReview(player.value);
      if (
        !current.ok ||
        current.value.id !== pending.reviewId ||
        current.value.revision !== pending.revision ||
        current.value.status !== "SUBMITTED"
      ) {
        pendingWithdrawals.delete(player.value);
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "A revisão em análise mudou. Use `$editar` novamente antes de retirar.",
          ),
        );
      }

      const withdrawn = await dependencies.registration.withdraw({
        playerId: player.value,
        revisionId: pending.reviewId,
        expectedRevision: pending.revision,
      });
      if (!withdrawn.ok) return withdrawn;

      pendingWithdrawals.delete(player.value);
      return openPersistedDraft(dependencies, context, player.value);
    }

    const current = await dependencies.registration.getCurrentReview(player.value);
    if (!current.ok) {
      if (current.error.code === "NOT_FOUND") {
        pendingWithdrawals.delete(player.value);
        return openPersistedDraft(dependencies, context, player.value);
      }
      return current;
    }

    if (current.value.status === "SUBMITTED") {
      pendingWithdrawals.set(player.value, {
        reviewId: current.value.id,
        revision: current.value.revision,
      });
      return reply(
        context,
        player.value,
        "⚠️ Sua ficha está em análise. Para retirar a revisão atual e abrir a edição, use `$editar sim`.",
      );
    }

    pendingWithdrawals.delete(player.value);
    if (current.value.status === "CHANGES_REQUESTED" || current.value.status === "WITHDRAWN") {
      return openPersistedDraft(dependencies, context, player.value);
    }

    return err(
      appError(
        "INVALID_STATE_TRANSITION",
        "Esta revisão não pode ser reaberta para edição neste estado.",
      ),
    );
  };

  const confirm: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    pendingWithdrawals.delete(player.value);
    const session = dependencies.sessions.get(player.value);
    if (session === null) {
      return err(
        appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `$registrar` para começar."),
      );
    }
    if (session.mode === "CHOOSING") {
      return err(
        appError("INVALID_STATE_TRANSITION", "Escolha o modo da ficha antes de confirmar."),
      );
    }

    const confirmationArg = args(context)[0]?.toLocaleLowerCase("pt-BR");
    if (confirmationArg === undefined) {
      const validation = validateRegistrationDraft(session.working);
      if (!validation.ok) return validation;
      const setup = await dependencies.setup.load();
      if (!setup.ok) return setup;
      pendingConfirmations.set(player.value, confirmationFingerprint(session));
      return reply(context, player.value, confirmationText(session, setup.value));
    }
    if (confirmationArg !== "sim") {
      return err(appError("VALIDATION_FAILED", "Use `$confirmar` ou `$confirmar sim`."));
    }

    const previewedFingerprint = pendingConfirmations.get(player.value);
    if (
      previewedFingerprint === undefined ||
      previewedFingerprint !== confirmationFingerprint(session)
    ) {
      pendingConfirmations.delete(player.value);
      return err(
        appError(
          "INVALID_STATE_TRANSITION",
          "A ficha atual ainda não foi revisada. Use `$confirmar` novamente antes de enviar.",
        ),
      );
    }

    const submitted = await dependencies.registration.saveAndSubmit({
      playerId: player.value,
      draft: session.working,
      expectedDraftRevision: session.persistedRevision,
      idempotencyKey: `${context.idempotencyKey}:registration-submit`,
    });
    if (!submitted.ok) return submitted;

    pendingConfirmations.delete(player.value);
    dependencies.sessions.clear(player.value);
    const playerReply = reply(
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
