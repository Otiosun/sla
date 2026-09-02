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
  readonly registration: Pick<RegistrationService, "getDraft" | "saveDraft">;
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

function fichaText(session: RegistrationConversationSession, setup: RegistrationSetup): string {
  const starter = session.working.starterFormId;
  const starterName =
    starter === undefined
      ? "—"
      : (setup.starterOptions.find((option) => option.formId === starter)?.displayName ?? starter);
  return [
    "📋 *FICHA ATUAL*",
    "",
    `Nome: ${value(session.working.trainerName)}`,
    `Idade: ${value(session.working.age)}`,
    `Gênero / pronomes: ${value(session.working.genderPronouns)}`,
    `Aparência: ${value(session.working.appearance)}`,
    `Personalidade: ${value(session.working.personality)}`,
    `História / resumo: ${value(session.working.backstory)}`,
    `Pokémon inicial: ${starterName}`,
    `Região: ${setup.regionDisplayName}`,
    "",
    session.dirty
      ? "⚠️ Existem alterações não salvas."
      : "Nenhuma alteração não salva nesta sessão.",
  ].join("\n");
}

async function existingPlayer(
  dependencies: RegistrationWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

export function createRegistrationWhatsAppRoutes(
  dependencies: RegistrationWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const register: Handler = async (context) => {
    const player = await dependencies.players.resolveOrCreatePlayer(identity(context));
    if (!player.ok) return player;
    const setup = await dependencies.setup.load();
    if (!setup.ok) return setup;
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
      return err(
        appError("INVALID_STATE_TRANSITION", "Escolha o modo da ficha antes de salvar."),
      );
    }

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

    const resumed = dependencies.sessions.start(player.value, {
      mode: "GUIDED",
      regionId: setup.value.regionId,
      baseDraft: draft.value.snapshot,
      baseRevision: draft.value.revision,
    });
    return reply(context, player.value, `↩️ Rascunho retomado.\n\n${guidedPrompt(resumed)}`);
  };

  return [
    { command: "registrar", handler: new FunctionalHandler(register), policy: POLICY },
    { command: "modo", handler: new FunctionalHandler(mode), policy: POLICY },
    { command: "ficha", handler: new FunctionalHandler(ficha), policy: POLICY },
    { command: "salvar", handler: new FunctionalHandler(save), policy: POLICY },
    { command: "continuar", handler: new FunctionalHandler(continueDraft), policy: POLICY },
  ];
}
