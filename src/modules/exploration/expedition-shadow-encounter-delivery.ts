import type { EncounterService } from "../encounter/service.js";
import type { EncounterView } from "../encounter/contracts.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { FirstActionOutcome } from "../../platform/exploration/postgres-expedition-first-action.js";
import { parseEncounterId, type PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, type Result } from "../../shared-kernel/result.js";
import {
  privateExpeditionSceneReply,
  renderExpeditionDirectEncounterScene,
} from "./expedition-whatsapp-scenes.js";

export interface CommittedExpeditionEncounterPresentation {
  readonly encounter: Pick<EncounterService, "get" | "observe">;
  readonly labels: {
    species(releaseId: string, speciesId: string): Promise<string | null>;
    area(releaseId: string, areaId: string): Promise<string | null>;
  };
}

function blocked(): Result<never> {
  return err(appError("FLOW_BLOCKED", "Committed expedition encounter cannot be presented safely"));
}

/**
 * A post-COMMIT delivery seam for an already-authorized DIRECT encounter.
 *
 * This is intentionally NOT a command route or an encounter-spawning service.
 * The caller must have passed the ACTIVE policy gate and obtained the
 * FirstActionOutcome from the transaction executor. No future search is
 * entitled to a DIRECT outcome until the published outcome policy exists.
 *
 * On retries, an already PRESENTED encounter is read without observing twice.
 * A failure to observe or resolve pinned catalog labels emits no success text;
 * the persisted expedition receipt remains available for safe replay.
 */
export async function presentCommittedExpeditionDirectEncounter(
  context: MessageHandlerContext,
  playerId: PlayerId,
  action: FirstActionOutcome,
  dependencies: CommittedExpeditionEncounterPresentation,
): Promise<Result<MessageHandlerResult>> {
  if (action.expedition.playerId !== playerId) return blocked();
  const payload = action.effectResult;
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("kind" in payload) ||
    payload.kind !== "EXPEDITION_DIRECT_ENCOUNTER" ||
    !("encounterId" in payload) ||
    typeof payload.encounterId !== "string"
  ) {
    return blocked();
  }
  const encounterId = parseEncounterId(payload.encounterId);
  if (!encounterId.ok) return blocked();

  const read = await dependencies.encounter.get(playerId, encounterId.value);
  if (!read.ok) return read;

  let view: EncounterView = read.value;
  if (view.status === "CREATED") {
    const observed = await dependencies.encounter.observe({
      playerId,
      encounterId: encounterId.value,
      expectedRevision: view.revision,
    });
    if (!observed.ok) return observed;
    view = observed.value;
  }
  if (view.status !== "PRESENTED" && view.status !== "ENGAGED") return blocked();

  const [speciesName, areaName] = await Promise.all([
    dependencies.labels.species(view.contentReleaseId, view.snapshot.speciesId),
    dependencies.labels.area(view.contentReleaseId, view.areaId),
  ]);
  if (speciesName === null || areaName === null) return blocked();

  // Until battle/capture contextual handlers are registered, do NOT offer
  // executable options merely because a wild Encounter has been observed.
  const scene = renderExpeditionDirectEncounterScene({
    action,
    observed: view,
    speciesName,
    locationName: areaName,
    choices: [],
  });
  return privateExpeditionSceneReply(context, "encounter", encounterId.value, scene);
}
