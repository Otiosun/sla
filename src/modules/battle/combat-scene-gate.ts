import { createHash } from "node:crypto";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import { MIN_COMBAT_SCENE_WORDS, parseCombatSceneMessage } from "./combat-scene-message.js";

export interface CombatSceneBinding {
  readonly subjectKind: "BATTLE" | "ENCOUNTER";
  readonly subjectId: string;
  readonly version: number;
  readonly actorKey: string;
  readonly provider: string;
  readonly originChat: string;
  readonly privateActionAllowed: boolean;
  readonly deadline: string | null;
  readonly knownArguments: Readonly<Record<string, readonly string[]>>;
  readonly forcedSwitch?: boolean;
  readonly captureAllowed?: boolean;
}
export interface PreparedSceneAction {
  readonly route: "COMBAT" | "EXPEDITION";
  readonly context: MessageHandlerContext;
}
export interface CombatSceneRecord {
  readonly binding: CombatSceneBinding;
  readonly action: PreparedSceneAction | null;
  readonly sceneMessageId: string | null;
  readonly sceneWordCount: number;
  readonly result: MessageHandlerResult | null;
}
export interface CombatSceneReceipt {
  readonly fingerprint: string;
  readonly scope: string;
  readonly result: MessageHandlerResult | null;
}
export interface CombatSceneTransaction {
  receipt(messageId: string): Promise<CombatSceneReceipt | null>;
  load(scope: string): Promise<CombatSceneRecord | null>;
  save(scope: string, record: CombatSceneRecord): Promise<void>;
  saveReceipt(messageId: string, receipt: CombatSceneReceipt): Promise<void>;
}
export interface CombatSceneRepository {
  serialized<T>(
    provider: string,
    sender: string,
    work: (tx: CombatSceneTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface CombatSceneGateDependencies {
  readonly repository: CombatSceneRepository;
  readonly now: () => Date;
  readonly bind: (
    context: MessageHandlerContext,
    prepared?: PreparedSceneAction,
  ) => Promise<Result<CombatSceneBinding>>;
  readonly execute: (
    action: PreparedSceneAction,
    binding: CombatSceneBinding,
  ) => Promise<Result<MessageHandlerResult>>;
  readonly recover: (record: CombatSceneRecord) => Promise<Result<MessageHandlerResult | null>>;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function combatSceneScope(binding: CombatSceneBinding): string {
  return digest([
    binding.provider,
    binding.subjectKind,
    binding.subjectId,
    binding.version,
    binding.actorKey,
    binding.originChat,
  ]);
}
export function combatScenePrivateReply(
  context: MessageHandlerContext,
  text: string,
): MessageHandlerResult {
  return {
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: context.idempotencyKey + ":combat-scene",
      },
    ],
  };
}

/** Durable preparation is independent of a process, message order or Outbox retry. */
export class CombatSceneGate {
  constructor(private readonly deps: CombatSceneGateDependencies) {}
  async receive(
    context: MessageHandlerContext,
    prepared?: PreparedSceneAction,
  ): Promise<Result<MessageHandlerResult>> {
    const fingerprint = digest([
      context.message,
      context.originalMessageText ?? null,
      prepared?.route ?? null,
    ]);
    return this.deps.repository.serialized(
      context.message.provider,
      context.message.senderRef,
      async (tx) => {
        const prior = await tx.receipt(context.message.externalMessageId);
        if (prior !== null && prior.fingerprint !== fingerprint)
          return err(
            appError(
              "FINGERPRINT_MISMATCH",
              "Mensagem de Cena retransmitida com conteúdo diferente.",
            ),
          );
        if (prior?.result) return ok(prior.result);
        // A PROCESSING receipt pins the old context across the effect/answer crash window.
        let record = prior === null ? null : await tx.load(prior.scope);
        if (record?.action && record.sceneMessageId !== null) {
          if (record.result !== null) return ok(record.result);
          const recovered = await this.deps.recover(record);
          if (!recovered.ok) return recovered;
          if (recovered.value !== null) {
            record = { ...record, result: recovered.value };
            await tx.save(prior!.scope, record);
            await tx.saveReceipt(context.message.externalMessageId, {
              ...prior!,
              result: recovered.value,
            });
            return ok(recovered.value);
          }
        }
        const bound = await this.deps.bind(context, prepared);
        if (!bound.ok) return bound;
        const binding = bound.value;
        const scope = combatSceneScope(binding);
        if (prior !== null && prior.scope !== scope)
          return err(
            appError("REVISION_CONFLICT", "O turno desta Cena já mudou. Consulte /batalha."),
          );
        const text = context.originalMessageText ?? context.message.text ?? "";
        if (context.message.forwarded === true)
          return err(
            appError(
              "VALIDATION_FAILED",
              "Envie uma Cena autoral; mensagens encaminhadas não são aceitas.",
            ),
          );
        const parsed = parseCombatSceneMessage(text, binding.knownArguments);
        if (!parsed.ok) return parsed;
        const scene = parsed.value;
        if (scene.command?.startsWith("/capturar") && binding.captureAllowed === false)
          return err(appError("FLOW_BLOCKED", "Captura não está disponível neste confronto."));
        if (prepared === undefined && scene.command === null && !scene.explicitScene)
          return err(
            appError("VALIDATION_FAILED", "Envie uma diretiva de combate ou /cena explícita."),
          );
        if (scene.command === "/capturar" && (binding.knownArguments.capturar?.length ?? 0) !== 1) {
          return ok(
            combatScenePrivateReply(
              context,
              (binding.knownArguments.capturar?.length ?? 0) > 1
                ? "Escolha uma Ball disponível: " +
                    binding.knownArguments.capturar!.join(", ") +
                    ". Use /capturar Nome da Ball."
                : "Você não possui uma Ball disponível para essa tentativa.",
            ),
          );
        }
        const privateMessage = context.message.chatRef === context.message.senderRef;
        if (
          context.message.provider !== binding.provider ||
          (context.message.chatRef !== binding.originChat &&
            !(privateMessage && binding.privateActionAllowed))
        ) {
          return err(appError("FLOW_BLOCKED", "Envie a Cena no chat de origem do confronto."));
        }
        const hasScene =
          scene.wordCount >= MIN_COMBAT_SCENE_WORDS &&
          (scene.command !== null || scene.explicitScene);
        if (binding.deadline !== null && this.deps.now().getTime() >= Date.parse(binding.deadline))
          return err(appError("FLOW_BLOCKED", "O prazo deste turno terminou. Consulte /batalha."));
        if (binding.forcedSwitch && scene.command?.startsWith("/trocar ")) {
          return this.deps.execute(
            {
              route: "COMBAT",
              context: { ...context, message: { ...context.message, text: scene.command } },
            },
            binding,
          );
        }
        if (hasScene && context.message.chatRef !== binding.originChat)
          return ok(
            combatScenePrivateReply(
              context,
              "Envie /cena com pelo menos 50 palavras no grupo de origem da batalha. Sua escolha continua privada.",
            ),
          );
        if ((scene.explicitScene || scene.wordCount > 0) && !hasScene) {
          return ok(
            combatScenePrivateReply(
              context,
              `Sua Cena tem ${scene.wordCount}/50 palavras; acrescente ${Math.max(0, 50 - scene.wordCount)}.`,
            ),
          );
        }
        if (record === null) record = await tx.load(scope);
        record ??= { binding, action: null, sceneMessageId: null, sceneWordCount: 0, result: null };
        if (record.result !== null)
          return ok(
            combatScenePrivateReply(
              context,
              "A ação deste turno já foi registrada. Consulte /batalha.",
            ),
          );
        let action =
          prepared ??
          (scene.command === null
            ? undefined
            : {
                route: "COMBAT" as const,
                context: { ...context, message: { ...context.message, text: scene.command } },
              });
        if (
          action &&
          record.action &&
          digest(action.context.message) !== digest(record.action.context.message)
        ) {
          return err(
            appError(
              "FLOW_BLOCKED",
              "Uma ação já está preparada para este turno. Consulte /batalha.",
            ),
          );
        }
        action ??= record.action ?? undefined;
        record = {
          ...record,
          action: action ?? null,
          sceneMessageId: hasScene ? context.message.externalMessageId : record.sceneMessageId,
          sceneWordCount: hasScene ? scene.wordCount : record.sceneWordCount,
        };
        await tx.save(scope, record);
        if (record.action === null || record.sceneMessageId === null) {
          const waiting = hasScene
            ? {
                resultRefType: binding.subjectKind,
                resultRefId: binding.subjectId,
                outgoing: [
                  {
                    channel: "whatsapp",
                    destinationRef: context.message.chatRef,
                    messageType: "REACTION",
                    payload: {
                      emoji: "✅",
                      targetExternalMessageId: context.message.externalMessageId,
                      targetSenderRef: context.message.senderRef,
                    },
                    idempotencyKey: context.idempotencyKey + ":scene-accepted",
                  },
                ],
              }
            : combatScenePrivateReply(
                context,
                "◇ *𝗖𝗘𝗡𝗔 𝗣𝗘𝗡𝗗𝗘𝗡𝗧𝗘*\n\nSua escolha foi preparada, sem consumir recursos.\nEnvie `/cena` com pelo menos 50 palavras no chat de origem do confronto.",
              );
          await tx.saveReceipt(context.message.externalMessageId, {
            fingerprint,
            scope,
            result: waiting,
          });
          return ok(waiting);
        }
        // Persist the execution claim BEFORE calling an idempotent canonical engine.
        await tx.saveReceipt(context.message.externalMessageId, {
          fingerprint,
          scope,
          result: null,
        });
        const executed = await this.deps.execute(record.action, record.binding);
        if (!executed.ok) return executed;
        // A private PvP choice can only produce a public factual resolution, never a command echo.
        const result = executed.value;
        await tx.save(scope, { ...record, result });
        await tx.saveReceipt(context.message.externalMessageId, { fingerprint, scope, result });
        return ok(result);
      },
    );
  }
}
