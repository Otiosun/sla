import type { PlayerId } from "../../shared-kernel/ids.js";
import { type AppError, appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CommunityChatContext } from "../community/contracts.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import {
  parseFullRegistrationTemplate,
  type RegistrationConversationField,
  type RegistrationConversationSession,
  type RegistrationConversationSessions,
} from "./conversation-session.js";

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
  readonly sessions: RegistrationConversationSessions;
  readonly community: CommunityContextResolver;
  readonly players: PlayerIdentityResolver;
  readonly setup: RegistrationSetupLoader;
  readonly replyIntent?: RegistrationReplyIntentVerifier;
}

const FIELD_LABELS: Readonly<Record<RegistrationConversationField, string>> = {
  trainerName: "Nome do treinador",
  age: "Idade",
  genderPronouns: "Gênero / pronomes",
  appearance: "Aparência",
  personality: "Personalidade",
  backstory: "História / resumo",
  starterFormId: "Pokémon inicial",
};

const FIELD_PROGRESS: Readonly<Record<RegistrationConversationField, string>> = {
  trainerName: "01/07",
  age: "02/07",
  genderPronouns: "03/07",
  appearance: "04/07",
  personality: "05/07",
  backstory: "06/07",
  starterFormId: "07/07",
};

const FIELD_INSTRUCTIONS: Readonly<Record<RegistrationConversationField, readonly string[]>> = {
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

function conversationOutboxKey(context: MessageHandlerContext): string {
  return `${context.idempotencyKey}:registration-conversation`;
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

function starterOptionsText(setup: RegistrationSetup): string {
  return setup.starterOptions
    .map((option, index) => `${index + 1}. ${option.displayName}`)
    .join("\n");
}

function ageCorrectionPrompt(): string {
  return [
    "〔!〕 *IDADE NÃO RECONHECIDA*",
    "",
    "BZZT... esse dado não fecha no registro.",
    "Envie um número inteiro maior que zero. Ex.: `17`.",
    "> Responda a esta mensagem com a idade corrigida.",
  ].join("\n");
}

function starterCorrectionPrompt(setup: RegistrationSetup): string {
  return [
    "〔!〕 *INICIAL NÃO RECONHECIDO*",
    "",
    "Esse Pokémon não está entre os iniciais disponíveis, roto.",
    starterOptionsText(setup),
    "",
    "> Responda com o número ou o nome.",
  ].join("\n");
}

function modeCorrectionPrompt(): string {
  return [
    "〔!〕 *ESCOLHA NÃO RECONHECIDA*",
    "",
    "`1` Modo guiado",
    "`2` Ficha completa",
    "",
    "> Responda a esta mensagem com `1` ou `2`.",
  ].join("\n");
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
      starterOptionsText(setup),
      "",
      "> Responda com o número ou o nome.",
    ].join("\n");
  }
  return [
    `〔⚡ ${FIELD_PROGRESS[session.currentField]}〕 *${FIELD_LABELS[session.currentField].toLocaleUpperCase("pt-BR")}*`,
    "",
    ...FIELD_INSTRUCTIONS[session.currentField],
  ].join("\n");
}

function fullTemplatePrompt(): string {
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
    "A região é Zhoulia e será preenchida automaticamente.",
    "> Nada é enviado só por preencher.",
    "> Depois você poderá revisar com `/ficha`.",
  ].join("\n");
}

function fullValidationCorrectionPrompt(error: AppError): string {
  const rawFields = error.details?.fields;
  const fields = Array.isArray(rawFields)
    ? rawFields.filter(
        (field): field is RegistrationConversationField =>
          typeof field === "string" && field in FIELD_LABELS,
      )
    : [];
  const invalidAge = fields.includes("age");
  const otherFields = fields.filter((field) => field !== "age");
  const guidance = [
    ...(invalidAge ? ["A idade deve ser um número inteiro maior que zero."] : []),
    ...(otherFields.length > 0
      ? [
          `Revise estes campos obrigatórios: ${otherFields.map((field) => FIELD_LABELS[field]).join(", ")}.`,
        ]
      : []),
    ...(fields.length === 0 ? ["Revise todos os campos obrigatórios."] : []),
  ];

  return [
    invalidAge && otherFields.length === 0
      ? "〔!〕 *IDADE NÃO RECONHECIDA*"
      : "〔!〕 *FICHA INCOMPLETA OU INVÁLIDA*",
    "",
    ...guidance,
    "Corrija e envie novamente a ficha completa:",
    "",
    fullTemplatePrompt(),
  ].join("\n");
}

function fullStarterCorrectionPrompt(setup: RegistrationSetup): string {
  return [
    "〔!〕 *INICIAL NÃO RECONHECIDO*",
    "",
    "Escolha uma destas opções:",
    starterOptionsText(setup),
    "",
    "Corrija e envie novamente a ficha completa:",
    "",
    fullTemplatePrompt(),
  ].join("\n");
}

function hasOnboardingCapability(context: CommunityChatContext): boolean {
  return context.known && context.capabilities.includes("onboarding");
}

function isLogicallyAwaitingReply(session: RegistrationConversationSession): boolean {
  if (session.mode === "CHOOSING") return true;
  if (session.mode === "GUIDED") return session.currentField !== null;
  return true;
}

function normalizedChoice(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
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

  public async admits(message: IncomingMessage): Promise<boolean> {
    const text = message.text;
    if (text === null || text.trim().length === 0 || /^[$/]/.test(text.trim())) return false;

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

    const active = this.dependencies.sessions.get(player.value.playerId);
    if (active === null) return false;
    return this.hasExpectedReplyIntent(message, active);
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const text = context.message.text;
    if (text === null || text.trim().length === 0 || /^[$/]/.test(text.trim())) return ok(null);

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

    const active = this.dependencies.sessions.get(player.value.playerId);
    if (active === null || !(await this.hasExpectedReplyIntent(context.message, active))) {
      return ok(null);
    }

    if (active.mode === "CHOOSING") {
      const chosen = this.dependencies.sessions.chooseMode(player.value.playerId, text);
      if (!chosen.ok) {
        return chosen.error.code === "VALIDATION_FAILED"
          ? textResult(
              context,
              player.value.playerId,
              modeCorrectionPrompt(),
              this.dependencies.sessions,
              true,
            )
          : chosen;
      }
      return textResult(
        context,
        player.value.playerId,
        chosen.value.mode === "GUIDED" ? guidedPrompt(chosen.value) : fullTemplatePrompt(),
        this.dependencies.sessions,
        true,
      );
    }

    if (active.mode === "GUIDED") {
      let answer = text;
      if (active.currentField === "starterFormId") {
        const setup = await this.dependencies.setup.load();
        if (!setup.ok) return setup;
        const starterFormId = resolveCanonicalStarterFormId(text, setup.value);
        if (!starterFormId.ok) {
          return starterFormId.error.code === "VALIDATION_FAILED"
            ? textResult(
                context,
                player.value.playerId,
                starterCorrectionPrompt(setup.value),
                this.dependencies.sessions,
                true,
              )
            : starterFormId;
        }
        answer = starterFormId.value;
      }
      const applied = this.dependencies.sessions.applyGuidedAnswer(player.value.playerId, answer);
      if (!applied.ok) {
        return active.currentField === "age" && applied.error.code === "VALIDATION_FAILED"
          ? textResult(
              context,
              player.value.playerId,
              ageCorrectionPrompt(),
              this.dependencies.sessions,
              true,
            )
          : applied;
      }

      if (applied.value.currentField === "starterFormId") {
        const setup = await this.dependencies.setup.load();
        if (!setup.ok) return setup;
        return textResult(
          context,
          player.value.playerId,
          guidedPrompt(applied.value, setup.value),
          this.dependencies.sessions,
          true,
        );
      }

      return textResult(
        context,
        player.value.playerId,
        guidedPrompt(applied.value),
        this.dependencies.sessions,
        applied.value.currentField !== null,
      );
    }

    const parsed = parseFullRegistrationTemplate(text);
    if (!parsed.ok) {
      return parsed.error.code === "VALIDATION_FAILED"
        ? textResult(
            context,
            player.value.playerId,
            fullValidationCorrectionPrompt(parsed.error),
            this.dependencies.sessions,
            true,
          )
        : parsed;
    }
    const setup = await this.dependencies.setup.load();
    if (!setup.ok) return setup;
    const starterFormId = resolveCanonicalStarterFormId(parsed.value.starterFormId, setup.value);
    if (!starterFormId.ok) {
      return starterFormId.error.code === "VALIDATION_FAILED"
        ? textResult(
            context,
            player.value.playerId,
            fullStarterCorrectionPrompt(setup.value),
            this.dependencies.sessions,
            true,
          )
        : starterFormId;
    }

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
      const applied = this.dependencies.sessions.setField(player.value.playerId, field, value);
      if (!applied.ok) return applied;
    }

    return textResult(
      context,
      player.value.playerId,
      "✅ Ficha lida para a sessão atual. Ela ainda não foi enviada nem persistida. Use `/ficha` para revisar, `/salvar` para guardar o rascunho ou `/confirmar` quando quiser conferir o envio.",
      this.dependencies.sessions,
      false,
    );
  }
}
