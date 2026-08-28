import type {
  RegionOption,
  ResolvePlayerResult,
  StarterOption,
} from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import { parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
  MessageRoutingMetadata,
} from "./contracts.js";
import type { MessageRouterPort } from "./ports.js";

type RegistrationPort = Pick<
  PlayerRegistrationService,
  | "findExistingPlayer"
  | "resolveOrCreatePlayer"
  | "createProfile"
  | "listRegionOptions"
  | "selectRegion"
>;

type StarterPort = Pick<
  PlayerStarterService,
  "prepareStarterSelection" | "listStarterOptions" | "grantStarter" | "completeOnboarding"
>;

function normalized(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function messageText(message: IncomingMessage): string {
  return message.text?.trim() ?? "";
}

function withoutCommandPrefix(value: string): string {
  return value.trim().replace(/^\$/, "");
}

function isStartIntent(value: string): boolean {
  return normalized(withoutCommandPrefix(value)) === "comecar";
}

function isMenuIntent(value: string): boolean {
  const token = normalized(withoutCommandPrefix(value)).split(/\s+/, 1)[0] ?? "";
  return token === "menu" || token === "ajuda" || token === "help" || token === "status";
}

function explicitBotIntent(message: IncomingMessage): boolean {
  return messageText(message).startsWith("$");
}

function isGroupMessage(message: IncomingMessage): boolean {
  return message.senderRef !== message.chatRef;
}

function argumentAfterCommand(value: string, command: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("$")) return trimmed;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (normalized(head ?? "") !== normalized(command)) return null;
  const argument = rest.join(" ").trim();
  return argument.length === 0 ? null : argument;
}

function textReply(
  context: MessageHandlerContext,
  text: string,
  resultRefId: string | null = null,
): MessageHandlerResult {
  return {
    resultRefType: resultRefId === null ? "ONBOARDING_UX" : "PLAYER",
    resultRefId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `onboarding.reply:${context.inboxMessageId}`,
      },
    ],
  };
}

function startPrompt(context: MessageHandlerContext): MessageHandlerResult {
  return textReply(
    context,
    [
      "Sua jornada ainda não foi iniciada.",
      "",
      "AÇÃO PRINCIPAL: responda COMEÇAR",
      "Nenhuma ficha é criada antes dessa confirmação.",
    ].join("\n"),
  );
}

function groupHandoff(context: MessageHandlerContext): MessageHandlerResult {
  return textReply(
    context,
    ["O cadastro é feito no privado.", "Abra a conversa direta com o bot e envie COMEÇAR."].join(
      "\n",
    ),
  );
}

function namePrompt(
  context: MessageHandlerContext,
  playerId: string,
  invalid = false,
): MessageHandlerResult {
  return textReply(
    context,
    [
      invalid ? "Esse nome não é válido." : "Vamos montar seu treinador.",
      "",
      "PRÓXIMA AÇÃO: envie o nome do treinador (1–40 caracteres).",
    ].join("\n"),
    playerId,
  );
}

function regionPrompt(
  context: MessageHandlerContext,
  playerId: string,
  options: readonly RegionOption[],
  invalid = false,
): MessageHandlerResult {
  const choices = options.map((option, index) => `${index + 1}. ${option.displayName}`);
  return textReply(
    context,
    [
      invalid
        ? "Essa região não está disponível para este onboarding."
        : "Escolha sua região inicial.",
      "",
      ...choices,
      "",
      "PRÓXIMA AÇÃO: responda com o número ou nome da região.",
    ].join("\n"),
    playerId,
  );
}

function starterPrompt(
  context: MessageHandlerContext,
  playerId: string,
  options: readonly StarterOption[],
  invalid = false,
): MessageHandlerResult {
  const choices = options.map(
    (option, index) => `${index + 1}. ${option.displayName} — Nv. ${option.starterLevel}`,
  );
  return textReply(
    context,
    [
      invalid ? "Esse starter não está disponível nesta seleção." : "Escolha seu primeiro Pokémon.",
      "",
      ...choices,
      "",
      "PRÓXIMA AÇÃO: responda com o número ou nome do Pokémon.",
    ].join("\n"),
    playerId,
  );
}

function completedPrompt(
  context: MessageHandlerContext,
  playerId: string,
  starterName: string | null,
): MessageHandlerResult {
  return textReply(
    context,
    [
      "Onboarding concluído.",
      starterName === null ? "Seu treinador está pronto." : `Starter confirmado: ${starterName}.`,
      "Seu estado foi salvo e já pode ser retomado após reinício.",
    ].join("\n"),
    playerId,
  );
}

function chooseRegion(options: readonly RegionOption[], rawInput: string): RegionOption | null {
  const input = argumentAfterCommand(rawInput, "regiao");
  if (input === null) return null;
  const ordinal = Number(input);
  if (Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= options.length) {
    return options[ordinal - 1] ?? null;
  }
  const key = normalized(input);
  const matches = options.filter(
    (option) => normalized(option.displayName) === key || normalized(option.slug) === key,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function chooseStarter(options: readonly StarterOption[], rawInput: string): StarterOption | null {
  const input = argumentAfterCommand(rawInput, "starter");
  if (input === null) return null;
  const ordinal = Number(input);
  if (Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= options.length) {
    return options[ordinal - 1] ?? null;
  }
  const key = normalized(input);
  const matches = options.filter((option) => normalized(option.displayName) === key);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export class OnboardingMessageRouter implements MessageRouterPort {
  public constructor(
    private readonly registration: RegistrationPort,
    private readonly starter: StarterPort,
    private readonly downstream: MessageRouterPort,
  ) {}

  public classify(message: IncomingMessage): MessageRoutingMetadata {
    return this.downstream.classify(message);
  }

  public async dispatch(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const identity = {
      provider: context.message.provider,
      externalId: context.message.senderRef,
    };
    const existing = await this.registration.findExistingPlayer(identity);
    if (!existing.ok) return existing;

    if (isGroupMessage(context.message)) {
      if (!explicitBotIntent(context.message)) return this.downstream.dispatch(context);
      if (existing.value === null || existing.value.state !== "COMPLETE") {
        return ok(groupHandoff(context));
      }
      return this.downstream.dispatch(context);
    }

    if (existing.value === null) {
      if (!isStartIntent(messageText(context.message))) return ok(startPrompt(context));
      const created = await this.registration.resolveOrCreatePlayer(identity);
      if (!created.ok) return created;
      return ok(namePrompt(context, created.value.playerId));
    }

    if (existing.value.state === "COMPLETE") {
      return this.downstream.dispatch(context);
    }

    return this.handleIncomplete(context, existing.value);
  }

  private async handleIncomplete(
    context: MessageHandlerContext,
    player: ResolvePlayerResult,
  ): Promise<Result<MessageHandlerResult>> {
    switch (player.state) {
      case "NEW":
        return this.handleName(context, player.playerId);
      case "PROFILE_CREATED":
        return this.handleRegion(context, player.playerId);
      case "REGION_SELECTED":
        return this.prepareStarter(context, player.playerId);
      case "STARTER_PENDING":
        return this.handleStarter(context, player.playerId);
      case "STARTER_GRANTED": {
        const completed = await this.starter.completeOnboarding(player.playerId);
        return completed.ok ? ok(completedPrompt(context, player.playerId, null)) : completed;
      }
      case "COMPLETE":
        return ok(completedPrompt(context, player.playerId, null));
      default:
        return err(appError("INVALID_STATE_TRANSITION", "Unsupported onboarding state"));
    }
  }

  private async handleName(
    context: MessageHandlerContext,
    playerId: ResolvePlayerResult["playerId"],
  ): Promise<Result<MessageHandlerResult>> {
    const input = messageText(context.message);
    if (
      input.length === 0 ||
      isStartIntent(input) ||
      isMenuIntent(input) ||
      input.startsWith("$")
    ) {
      return ok(namePrompt(context, playerId));
    }

    const created = await this.registration.createProfile(playerId, {
      trainerName: input,
      locale: null,
      metadata: {},
    });
    if (!created.ok) {
      return created.error.code === "VALIDATION_FAILED"
        ? ok(namePrompt(context, playerId, true))
        : created;
    }
    const options = await this.registration.listRegionOptions(playerId);
    if (!options.ok) return options;
    if (options.value.length === 0) {
      return err(appError("FEATURE_UNAVAILABLE", "No onboarding region is available"));
    }
    return ok(regionPrompt(context, playerId, options.value));
  }

  private async handleRegion(
    context: MessageHandlerContext,
    playerId: ResolvePlayerResult["playerId"],
  ): Promise<Result<MessageHandlerResult>> {
    const options = await this.registration.listRegionOptions(playerId);
    if (!options.ok) return options;
    if (options.value.length === 0) {
      return err(appError("FEATURE_UNAVAILABLE", "No onboarding region is available"));
    }
    const input = messageText(context.message);
    if (isMenuIntent(input) || isStartIntent(input)) {
      return ok(regionPrompt(context, playerId, options.value));
    }
    const selected = chooseRegion(options.value, input);
    if (selected === null) return ok(regionPrompt(context, playerId, options.value, true));

    const changed = await this.registration.selectRegion(playerId, { regionId: selected.regionId });
    if (!changed.ok) return changed;
    return this.prepareStarter(context, playerId);
  }

  private async prepareStarter(
    context: MessageHandlerContext,
    playerId: ResolvePlayerResult["playerId"],
  ): Promise<Result<MessageHandlerResult>> {
    const prepared = await this.starter.prepareStarterSelection(playerId);
    if (!prepared.ok) return prepared;
    return ok(starterPrompt(context, playerId, prepared.value.options));
  }

  private async handleStarter(
    context: MessageHandlerContext,
    playerId: ResolvePlayerResult["playerId"],
  ): Promise<Result<MessageHandlerResult>> {
    const options = await this.starter.listStarterOptions(playerId);
    if (!options.ok) return options;
    const input = messageText(context.message);
    if (isMenuIntent(input) || isStartIntent(input)) {
      return ok(starterPrompt(context, playerId, options.value));
    }
    const selected = chooseStarter(options.value, input);
    if (selected === null) return ok(starterPrompt(context, playerId, options.value, true));

    const correlationId = parseCorrelationId(context.correlationId);
    if (!correlationId.ok) return correlationId;
    const granted = await this.starter.grantStarter(
      playerId,
      { formId: selected.formId },
      correlationId.value,
    );
    if (!granted.ok) return granted;
    const completed = await this.starter.completeOnboarding(playerId);
    if (!completed.ok) return completed;
    return ok(completedPrompt(context, playerId, selected.displayName));
  }
}
