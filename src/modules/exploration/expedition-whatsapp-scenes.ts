import type { CaptureAttemptResult } from "../capture/contracts.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { EncounterView } from "../encounter/contracts.js";
import type { FirstActionOutcome } from "../../platform/exploration/postgres-expedition-first-action.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  renderExpeditionMenuChoices,
  type ExpeditionMenuChoice,
} from "./expedition-contextual-menu.js";
import { EXPEDITION_DURATION_MINUTES } from "./expedition-clock.js";

/**
 * Presentation only. This file does not register WhatsApp commands, roll an
 * encounter, authorize a capture, settle XP, spend Balls or mutate a session.
 * Callers must pass a canonical, committed first-action receipt AND a
 * subsequently observed EncounterService view of the SAME encounter.
 */
export type ExpeditionPresentedEncounter = Pick<
  EncounterView,
  "encounterId" | "playerId" | "areaId" | "contentReleaseId" | "status" | "snapshot"
>;

type ExpeditionCaptureDisplay = Pick<
  CaptureAttemptResult,
  "encounterId" | "status" | "pokemonInstanceId" | "placement" | "replayed"
>;

const AVAILABLE_ENCOUNTER_INTENTS = new Set(["BATTLE", "CAPTURE", "IGNORE_ENCOUNTER"]);

function blocked(): Result<never> {
  return err(
    appError(
      "FLOW_BLOCKED",
      "Expedition WhatsApp scene is not backed by a consistent canonical result",
    ),
  );
}

function safeLabel(value: string): string {
  return value
    .replace(/[\r\n*_~`/<>]/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 70);
}

function hasText(value: string): boolean {
  return value.length > 0 && safeLabel(value).length > 0;
}

function isDirectReceipt(value: unknown): value is {
  readonly kind: "EXPEDITION_DIRECT_ENCOUNTER";
  readonly encounterId: string;
  readonly contentReleaseId: string;
  readonly areaId: string;
  readonly formId: string;
  readonly level: number;
  readonly encounterStatus: "CREATED";
} {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.kind === "EXPEDITION_DIRECT_ENCOUNTER" &&
    typeof entry.encounterId === "string" &&
    typeof entry.contentReleaseId === "string" &&
    typeof entry.areaId === "string" &&
    typeof entry.formId === "string" &&
    Number.isSafeInteger(entry.level) &&
    entry.encounterStatus === "CREATED"
  );
}

/**
 * Takes a persisted DIRECT receipt, not a made-up search RNG result.
 * CREATED is never presented as a wild sighting: EncounterService.observe
 * must have completed before WhatsApp shows the encounter.
 */
export function renderExpeditionDirectEncounterScene(input: {
  readonly action: FirstActionOutcome;
  readonly observed: ExpeditionPresentedEncounter;
  readonly speciesName: string;
  readonly locationName: string;
  readonly choices: readonly ExpeditionMenuChoice[];
}): Result<string> {
  const { action, observed, choices } = input;
  const receipt = action.effectResult;
  if (
    !isDirectReceipt(receipt) ||
    receipt.encounterId !== observed.encounterId ||
    receipt.contentReleaseId !== observed.contentReleaseId ||
    receipt.areaId !== observed.areaId ||
    receipt.formId !== observed.snapshot.formId ||
    receipt.level !== observed.snapshot.level ||
    action.expedition.playerId !== observed.playerId ||
    action.expedition.currentAreaId !== observed.areaId ||
    !["PRESENTED", "ENGAGED"].includes(observed.status) ||
    !Number.isSafeInteger(action.expedition.elapsedMinutes) ||
    action.expedition.elapsedMinutes < 30 ||
    action.expedition.elapsedMinutes > EXPEDITION_DURATION_MINUTES ||
    !hasText(input.speciesName) ||
    !hasText(input.locationName) ||
    choices.some((choice) => !AVAILABLE_ENCOUNTER_INTENTS.has(choice.intent)) ||
    new Set(choices.map((choice) => choice.optionNo)).size !== choices.length
  ) {
    return blocked();
  }

  const remaining = EXPEDITION_DURATION_MINUTES - action.expedition.elapsedMinutes;
  const lines = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*",
    "　RotomDex · Exploração",
    "",
    "> _Bip-bip! Um Pokémon selvagem apareceu!_",
    "",
    `◇ *${safeLabel(input.speciesName)}* · Nv. ${observed.snapshot.level}`,
    `⌖ *Local:* ${safeLabel(input.locationName)}`,
    `🕒 *Busca concluída:* 30 min · ${remaining} min restantes`,
  ];
  if (observed.snapshot.shiny) lines.push("✧ *Aparência incomum detectada!*");
  if (choices.length > 0) {
    lines.push("", renderExpeditionMenuChoices(choices));
  } else {
    lines.push("", "› _Ações de batalha e captura ainda não estão disponíveis neste fluxo._");
  }
  return ok(lines.join("\n"));
}

/**
 * Never fabricate XP, Pokédollars, a free Ball, or a new inventory grant.
 * A resolved CaptureService result is the only source of capture claims.
 */
export function renderExpeditionCaptureResolutionScene(input: {
  readonly encounter: ExpeditionPresentedEncounter;
  readonly capture: ExpeditionCaptureDisplay;
  readonly speciesName: string;
}): Result<string> {
  const { encounter, capture } = input;
  if (
    capture.encounterId !== encounter.encounterId ||
    !hasText(input.speciesName) ||
    (capture.status === "CAPTURED" &&
      (capture.pokemonInstanceId === null || capture.placement === null)) ||
    (capture.status === "FAILED" &&
      (capture.pokemonInstanceId !== null || capture.placement !== null))
  ) {
    return blocked();
  }
  const name = safeLabel(input.speciesName);
  if (capture.status === "FAILED") {
    return ok(
      [
        "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗣𝗧𝗨𝗥𝗔*",
        "",
        `> _${name} escapou da Ball!_`,
        "",
        "› _A tentativa foi registrada. Confira seu encontro antes de agir novamente._",
      ].join("\n"),
    );
  }

  const placement = capture.placement;
  if (
    placement === null ||
    !Number.isSafeInteger(placement.slotNo) ||
    placement.slotNo < 1 ||
    (placement.placementKind === "BOX" &&
      (!Number.isSafeInteger(placement.boxNo) || (placement.boxNo ?? 0) < 1))
  ) {
    return blocked();
  }
  const destination =
    placement.placementKind === "TEAM"
      ? `Equipe · posição ${placement.slotNo}`
      : `Box ${placement.boxNo} · posição ${placement.slotNo}`;
  return ok(
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗣𝗧𝗨𝗥𝗔*",
      "",
      `> _Bip! ${name} foi capturado!_`,
      `◈ *Destino:* ${destination}`,
      "",
      "› _Captura confirmada. Consulte /equipe ou /box para conferir._",
    ].join("\n"),
  );
}

/**
 * Adapter to the existing Messaging Outbox contract, not a direct Baileys send.
 * Distinct semantic stages get different Inbox-derived keys; the delivery
 * worker, never this presenter, owns retry/deduplication after commit.
 */
export function privateExpeditionSceneReply(
  context: MessageHandlerContext,
  stage: "encounter" | "capture",
  encounterId: ExpeditionPresentedEncounter["encounterId"],
  scene: Result<string>,
): Result<MessageHandlerResult> {
  if (!scene.ok) return scene;
  if (scene.value.length === 0 || !context.message.senderRef.trim()) return blocked();
  return ok({
    resultRefType: "ENCOUNTER",
    resultRefId: encounterId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text: scene.value },
        idempotencyKey: `${context.idempotencyKey}:expedition-${stage}`,
      },
    ],
  });
}
