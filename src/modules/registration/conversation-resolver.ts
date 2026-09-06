import type { CommunityChatContext } from "../community/contracts.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  type RegistrationConversationField,
  type RegistrationConversationSession,
  type RegistrationConversationSessions,
  parseFullRegistrationTemplate,
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
  readonly replyIntent: RegistrationReplyIntentVerifier;
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

function guidedPrompt(session: RegistrationConversationSession, setup?: RegistrationSetup): string {
  if (session.currentField === null) {
    return "✅ Ficha preenchida. Use `$ficha` para revisar ou `$confirmar` para conferir o envio. Se quiser continuar depois, use `$salvar`.";
  }
  if (session.currentField === "starterFormId" && setup !== undefined) {
    return [
      "🔥 *Pokémon inicial*",
      "",
      starterOptionsText(setup),
      "",
      "Responda a esta mensagem com o número ou o nome.",
    ].join("\n");
  }
  return `📝 *${FIELD_LABELS[session.currentField]}*\n\nResponda a esta mensagem.`;
}

function fullTemplatePrompt(): string {
  return [
    "📋 *FICHA COMPLETA*",
    "",
    "Preencha o modelo abaixo e envie respondendo a esta mensagem:",
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
    "Nada será persistido até `$salvar` ou a confirmação final.",
  ].join("\n");
}

function hasOnboardingCapability(context: CommunityChatContext): boolean {
  return context.known && context.capabilities.includes("onboarding");
}

function isAwaitingReply(session: RegistrationConversationSession): boolean {
  if (session.expectedReplyOutboxIdempotencyKey === null) return false;
  if (session.mode === "CHOOSING") return true;
  if (session.mode === "GUIDED") return session.currentField !== null;
  return !session.dirty;
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
    if (!isAwaitingReply(session)) return false;
    const replyToExternalMessageId = message.replyToExternalMessageId;
    const expectedOutboxIdempotencyKey = session.expectedReplyOutboxIdempotencyKey;
    if (replyToExternalMessageId === null || expectedOutboxIdempotencyKey === null) return false;
    return this.dependencies.replyIntent.isExpectedReply({
      provider: message.provider,
      chatRef: message.chatRef,
      replyToExternalMessageId,
      expectedOutboxIdempotencyKey,
    });
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

    const active = this.dependencies.sessions.get(player.value.playerId);
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

    const active = this.dependencies.sessions.get(player.value.playerId);
    if (active === null || !(await this.hasExpectedReplyIntent(context.message, active))) {
      return ok(null);
    }

    if (active.mode === "CHOOSING") {
      const chosen = this.dependencies.sessions.chooseMode(player.value.playerId, text);
      if (!chosen.ok) return chosen;
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
        if (!starterFormId.ok) return starterFormId;
        answer = starterFormId.value;
      }
      const applied = this.dependencies.sessions.applyGuidedAnswer(player.value.playerId, answer);
      if (!applied.ok) return applied;

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
      const applied = this.dependencies.sessions.setField(player.value.playerId, field, value);
      if (!applied.ok) return applied;
    }

    return textResult(
      context,
      player.value.playerId,
      "✅ Ficha lida para a sessão atual. Ela ainda não foi enviada nem persistida. Use `$ficha` para revisar, `$salvar` para guardar o rascunho ou `$confirmar` quando quiser conferir o envio.",
      this.dependencies.sessions,
      false,
    );
  }
}
