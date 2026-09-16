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

const EDITABLE_FIELDS: readonly RegistrationConversationField[] = [
  "trainerName",
  "age",
  "genderPronouns",
  "appearance",
  "personality",
  "backstory",
  "starterFormId",
];

const EDIT_LABELS: Readonly<Record<RegistrationConversationField, string>> = {
  ...LABELS,
  trainerName: "Nome",
};

function args(context: MessageHandlerContext): readonly string[] {
  return (context.message.text?.trim() ?? "").split(/\s+/).slice(1);
}

function identity(context: MessageHandlerContext) {
  return { provider: context.message.provider, externalId: context.message.senderRef };
}

function commandOutboxKey(context: MessageHandlerContext): string {
  return `${context.idempotencyKey}:registration-command`;
}

function reply(
  context: MessageHandlerContext,
  playerId: PlayerId,
  text: string,
  sessions?: RegistrationConversationSessions,
  expectsReply = false,
): Result<MessageHandlerResult> {
  const idempotencyKey = commandOutboxKey(context);
  if (expectsReply) {
    if (sessions === undefined) {
      return err(appError("ACTION_INVALID", "Registration prompt session tracker is unavailable"));
    }
    const tracked = sessions.expectReply(playerId, idempotencyKey);
    if (!tracked.ok) return tracked;
  }

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

function parseMode(value: string | undefined): RegistrationEditingMode | null {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
  if (["1", "guiado", "passo-a-passo", "passo_a_passo"].includes(normalized)) return "GUIDED";
  if (["2", "completo", "completa", "ficha"].includes(normalized)) return "FULL";
  return null;
}

function selectedEditField(value: string | undefined): RegistrationConversationField | null {
  if (value === undefined || !/^[1-7]$/.test(value)) return null;
  return EDITABLE_FIELDS[Number(value) - 1] ?? null;
}

function guidedPrompt(session: RegistrationConversationSession, setup?: RegistrationSetup): string {
  if (session.currentField === null) {
    return "〔✓〕 *REGISTRO PREENCHIDO*\n\n> Revise com `/ficha` ou use `/confirmar`.";
  }
  if (session.currentField === "starterFormId" && setup !== undefined) {
    return [
      "〔⚡ 07/07〕 *POKÉMON INICIAL*",
      "",
      "Último dado. Agora escolhe direito, roto!",
      "",
      ...setup.starterOptions.map((option, index) => `${index + 1}. ${option.displayName}`),
      "",
      "> Responda com o número ou o nome.",
    ].join("\n");
  }
  const progress = String(EDITABLE_FIELDS.indexOf(session.currentField) + 1).padStart(2, "0");
  const instructions: Readonly<Record<RegistrationConversationField, readonly string[]>> = {
    trainerName: ["Como devo registrar seu treinador?", "> Responda a esta mensagem com o nome."],
    age: ["Quantos anos ele tem?", "> Só o número. Ex.: `17`"],
    genderPronouns: [
      "Como isso deve aparecer no registro?",
      "> Ex.: `ela/dela`, `ele/dele` ou como preferir.",
    ],
    appearance: ["Descreva a aparência do seu treinador.", "> Sugestão: 2–4 linhas."],
    personality: ["Como seu treinador costuma agir, pensar e reagir?", "> Sugestão: 2–4 linhas."],
    backstory: [
      "Resuma a história do seu treinador antes da jornada.",
      "> Um resumo curto já basta.",
    ],
    starterFormId: [
      "Último dado. Agora escolhe direito, roto!",
      "> Responda com o número ou o nome.",
    ],
  };
  return [
    `〔⚡ ${progress}/07〕 *${LABELS[session.currentField].toLocaleUpperCase("pt-BR")}*`,
    "",
    ...instructions[session.currentField],
  ].join("\n");
}

function editPrompt(session: RegistrationConversationSession, setup?: RegistrationSetup): string {
  if (session.currentField !== null) return guidedPrompt(session, setup);
  return [
    "〔✎〕 *EDITAR REGISTRO*",
    "",
    "Escolha o campo que deseja alterar:",
    ...EDITABLE_FIELDS.map((field, index) => `\`${index + 1}\` ${EDIT_LABELS[field]}`),
    "",
    "> Ex.: `/editar 5`",
    "Para preencher a ficha completa, use `/modo completo`.",
  ].join("\n");
}

function selectedFieldPrompt(session: RegistrationConversationSession): string {
  if (session.currentField === null) return editPrompt(session);
  const progress = String(EDITABLE_FIELDS.indexOf(session.currentField) + 1).padStart(2, "0");
  return [
    `〔✎ ${progress}/07〕 *${LABELS[session.currentField].toLocaleUpperCase("pt-BR")}*`,
    "",
    "> Responda a esta mensagem com o novo valor.",
  ].join("\n");
}

function fullTemplate(setup: RegistrationSetup): string {
  return [
    "〔▣〕 *ROTOMDEX // FICHA COMPLETA*",
    "",
    "Preencha o registro abaixo e responda a esta mensagem.",
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
    "> Nada é enviado só por preencher.",
    "> Depois você poderá revisar com `/ficha`.",
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

function starterEditPrompt(setup: RegistrationSetup): string {
  return [
    "〔✎ 07/07〕 *POKÉMON INICIAL*",
    "",
    ...setup.starterOptions.map((option, index) => `${index + 1}. ${option.displayName}`),
    "",
    "> Responda a esta mensagem com o número ou o nome.",
  ].join("\n");
}

function fichaText(session: RegistrationConversationSession, setup: RegistrationSetup): string {
  return [
    "〔▣〕 *REGISTRO DO TREINADOR*",
    session.dirty ? "`RASCUNHO`" : "`RASCUNHO SALVO`",
    "",
    `*Nome* › ${value(session.working.trainerName)}`,
    `*Idade* › ${value(session.working.age)}`,
    `*Gênero / pronomes* › ${value(session.working.genderPronouns)}`,
    `*Aparência* › ${value(session.working.appearance)}`,
    `*Personalidade* › ${value(session.working.personality)}`,
    `*História / resumo* › ${value(session.working.backstory)}`,
    `*Pokémon inicial* › ${starterDisplayName(session.working.starterFormId, setup)}`,
    `*Região* › ${setup.regionDisplayName}`,
    "",
    ...(session.dirty ? ["〔!〕 Existem alterações não salvas.", ""] : []),
    validateRegistrationDraft(session.working).ok
      ? "> Revise os dados e use `/confirmar`."
      : "> Continue o registro ou use `/salvar` para guardar o progresso.",
  ].join("\n");
}

function confirmationText(
  session: RegistrationConversationSession,
  setup: RegistrationSetup,
): string {
  return [
    "〔▣〕 *PRÉVIA DE ENVIO*",
    "`AINDA NÃO ENVIADO`",
    "",
    `*Nome* › ${value(session.working.trainerName)}`,
    `*Idade* › ${value(session.working.age)}`,
    `*Gênero / pronomes* › ${value(session.working.genderPronouns)}`,
    `*Aparência* › ${value(session.working.appearance)}`,
    `*Personalidade* › ${value(session.working.personality)}`,
    `*História / resumo* › ${value(session.working.backstory)}`,
    `*Pokémon inicial* › ${starterDisplayName(session.working.starterFormId, setup)}`,
    `*Região* › ${setup.regionDisplayName}`,
    "",
    "> Confira tudo acima.",
    "> Se estiver correto: `/confirmar sim`",
    "> Para rever antes: `/ficha`",
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
  const setup = await dependencies.setup.load();
  if (!setup.ok) return setup;

  const resumed = dependencies.sessions.start(playerId, {
    mode: "GUIDED",
    regionId: draft.value.snapshot.regionId,
    baseDraft: draft.value.snapshot,
    baseRevision: draft.value.revision,
  });
  return reply(
    context,
    playerId,
    editPrompt(resumed, setup.value),
    dependencies.sessions,
    resumed.currentField !== null,
  );
}

export function createRegistrationWhatsAppRoutes(
  dependencies: RegistrationWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const pendingConfirmations = new Map<PlayerId, string>();
  const confirmations =
    dependencies.registration as RegistrationWhatsAppDependencies["registration"] & {
      readonly saveConfirmationPreview?: (playerId: PlayerId, fingerprint: string) => Promise<void>;
      readonly getConfirmationPreview?: (playerId: PlayerId) => Promise<string | null>;
      readonly clearConfirmationPreview?: (playerId: PlayerId) => Promise<void>;
    };
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
        "〔⚡〕 𝗥𝗢𝗧𝗢𝗠𝗗𝗘𝗫",
        "*ABRINDO NOVO REGISTRO...*",
        "",
        "Certo. Preciso montar sua ficha de Treinador.",
        "",
        "`1` *GUIADO*",
        "Eu puxo um dado por vez.",
        "",
        "`2` *FICHA COMPLETA*",
        "Você envia tudo de uma vez.",
        "",
        "> Responda a esta mensagem com `1` ou `2`.",
      ].join("\n"),
      dependencies.sessions,
      true,
    );
  };

  const mode: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const selected = parseMode(args(context)[0]);
    if (selected === null) {
      return err(appError("VALIDATION_FAILED", "Use `/modo guiado` ou `/modo completo`."));
    }
    const setup = selected === "GUIDED" ? await dependencies.setup.load() : null;
    if (setup !== null && !setup.ok) return setup;
    pendingConfirmations.delete(player.value);
    pendingWithdrawals.delete(player.value);
    const switched = dependencies.sessions.switchMode(player.value, selected);
    if (!switched.ok) return switched;
    if (selected === "GUIDED") {
      return reply(
        context,
        player.value,
        guidedPrompt(switched.value, setup?.value),
        dependencies.sessions,
        switched.value.currentField !== null,
      );
    }
    const fullSetup = await dependencies.setup.load();
    return fullSetup.ok
      ? reply(context, player.value, fullTemplate(fullSetup.value), dependencies.sessions, true)
      : fullSetup;
  };

  const ficha: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    let session = dependencies.sessions.get(player.value);
    if (session === null) {
      const draft = await dependencies.registration.getDraft(player.value);
      if (!draft.ok) {
        return draft.error.code === "NOT_FOUND"
          ? reply(
              context,
              player.value,
              "〔▣〕 Nenhuma ficha está aberta. Use `/registrar` para começar.",
            )
          : draft;
      }
      session = dependencies.sessions.start(player.value, {
        mode: "GUIDED",
        regionId: draft.value.snapshot.regionId,
        baseDraft: draft.value.snapshot,
        baseRevision: draft.value.revision,
      });
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
        appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `/registrar` para começar."),
      );
    }
    if (session.mode === "CHOOSING") {
      return err(appError("INVALID_STATE_TRANSITION", "Escolha o modo da ficha antes de salvar."));
    }

    const setup =
      session.mode === "GUIDED" && !validateRegistrationDraft(session.working).ok
        ? await dependencies.setup.load()
        : null;
    if (setup !== null && !setup.ok) return setup;

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
      clean.mode === "GUIDED" && clean.currentField === null
        ? "〔✓〕 *RASCUNHO SALVO*\n\nRegistro guardado.\n\n> Revise com `/ficha` ou use `/confirmar`."
        : `〔✓〕 *RASCUNHO SALVO*\n\nRegistro guardado.\n\n${clean.mode === "GUIDED" ? guidedPrompt(clean, setup?.value) : "Use `/ficha` para revisar ou `/modo completo` para reenviar a ficha completa."}`,
      dependencies.sessions,
      clean.mode === "GUIDED" && clean.currentField !== null,
    );
  };

  const continueDraft: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    const draft = await dependencies.registration.getDraft(player.value);
    if (!draft.ok) {
      return err(
        draft.error.code === "NOT_FOUND"
          ? appError("NOT_FOUND", "Nenhum rascunho salvo. Use `/registrar` para começar.")
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
    return reply(
      context,
      player.value,
      `〔‹〕 *REGISTRO RETOMADO*\n\nEncontrei seu rascunho salvo.\n\n${guidedPrompt(resumed, setup.value)}`,
      dependencies.sessions,
      resumed.currentField !== null,
    );
  };

  const edit: Handler = async (context) => {
    const player = await existingPlayer(dependencies, context);
    if (!player.ok) return player;
    pendingConfirmations.delete(player.value);

    const editArg = args(context)[0]?.toLocaleLowerCase("pt-BR");
    const field = selectedEditField(editArg);

    if (field !== null) {
      if (field === "starterFormId") {
        const setup = await dependencies.setup.load();
        if (!setup.ok) return setup;
        const selected = dependencies.sessions.selectGuidedField(player.value, field);
        if (!selected.ok) return selected;
        return reply(
          context,
          player.value,
          starterEditPrompt(setup.value),
          dependencies.sessions,
          true,
        );
      }
      const selected = dependencies.sessions.selectGuidedField(player.value, field);
      if (!selected.ok) return selected;
      return reply(
        context,
        player.value,
        selectedFieldPrompt(selected.value),
        dependencies.sessions,
        true,
      );
    }

    if (editArg !== undefined && editArg !== "sim") {
      return reply(
        context,
        player.value,
        "〔!〕 Escolha um campo de `/editar 1` até `/editar 7`. Use `/editar` para ver a lista.",
      );
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
            "A revisão em análise mudou. Use `/editar` novamente antes de retirar.",
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
        "⚠️ Sua ficha está em análise. Para retirar a revisão atual e abrir a edição, use `/editar sim`.",
      );
    }

    pendingWithdrawals.delete(player.value);
    if (
      current.value.status === "CHANGES_REQUESTED" ||
      current.value.status === "WITHDRAWN" ||
      current.value.status === "REJECTED"
    ) {
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
    const currentReview = await dependencies.registration.getCurrentReview(player.value);
    if (currentReview.ok && currentReview.value.status === "SUBMITTED") {
      pendingConfirmations.delete(player.value);
      await confirmations.clearConfirmationPreview?.(player.value);
      dependencies.sessions.clear(player.value);
      return reply(
        context,
        player.value,
        "〔i〕 Sua ficha já foi enviada e está em análise da equipe. Não precisa confirmar novamente.",
      );
    }
    const session = dependencies.sessions.get(player.value);
    if (session === null) {
      const current = await dependencies.registration.getCurrentReview(player.value);
      if (current.ok && current.value.status === "SUBMITTED") {
        return reply(
          context,
          player.value,
          "〔i〕 Sua ficha já foi enviada e está em análise da equipe. Não precisa confirmar novamente.",
        );
      }
      if (current.ok && current.value.status === "APPROVED") {
        return reply(
          context,
          player.value,
          "〔i〕 Sua ficha já foi aprovada. A ativação do seu treinador está em andamento; aguarde a confirmação para usar `/menu`.",
        );
      }
      if (current.ok && current.value.status === "CHANGES_REQUESTED") {
        return reply(
          context,
          player.value,
          "〔!〕 Sua ficha aguarda ajustes. Use `/editar` para reabrir a ficha antes de confirmar novamente.",
        );
      }
      if (current.ok && current.value.status === "REJECTED") {
        return reply(
          context,
          player.value,
          "〔!〕 Esta ficha não está disponível para confirmação. Use `/editar` para consultar as próximas opções.",
        );
      }
      if (current.ok && current.value.status === "WITHDRAWN") {
        return reply(
          context,
          player.value,
          "〔i〕 Esta ficha foi retirada da análise. Use `/ficha` ou `/editar` antes de confirmar novamente.",
        );
      }
      if (!current.ok && current.error.code !== "NOT_FOUND") return current;
      return err(
        appError("NOT_FOUND", "Nenhuma ficha está aberta. Use `/registrar` para começar."),
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
      const fingerprint = confirmationFingerprint(session);
      pendingConfirmations.set(player.value, fingerprint);
      await confirmations.saveConfirmationPreview?.(player.value, fingerprint);
      return reply(context, player.value, confirmationText(session, setup.value));
    }
    if (confirmationArg !== "sim") {
      return err(appError("VALIDATION_FAILED", "Use `/confirmar` ou `/confirmar sim`."));
    }

    const previewedFingerprint =
      pendingConfirmations.get(player.value) ??
      (await confirmations.getConfirmationPreview?.(player.value));
    if (
      previewedFingerprint === undefined ||
      previewedFingerprint !== confirmationFingerprint(session)
    ) {
      pendingConfirmations.delete(player.value);
      await confirmations.clearConfirmationPreview?.(player.value);
      return err(
        appError(
          "INVALID_STATE_TRANSITION",
          "A ficha atual ainda não foi revisada. Use `/confirmar` novamente antes de enviar.",
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
    await confirmations.clearConfirmationPreview?.(player.value);
    dependencies.sessions.clear(player.value);
    const playerReply = reply(
      context,
      player.value,
      "〔✓〕 *REGISTRO TRANSMITIDO*\n\nSua ficha foi enviada para análise da equipe. Esta revisão ficou congelada exatamente como você confirmou.\n\n> Não precisa reenviar. Qualquer retorno aparecerá por aqui.",
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
            text: "〔▣〕 *NOVA FICHA PARA REVISÃO*\n\n> `/verficha` — abrir a ficha\n> `/aprovar` · `/ajustes` · `/rejeitar` — decidir",
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
