import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";
import type { EncounterView } from "../encounter/contracts.js";
import type { EncounterService } from "../encounter/service.js";
import type { IncidentalOutcomeAuthorization } from "./expedition-incidental-capture-action.js";

/**
 * The approved incidental scene offers a Ball immediately. CaptureService
 * requires ENGAGED, not CREATED/PRESENTED, so the trusted presentation
 * boundary must use EncounterService's canonical transitions before issuing
 * a menu. We do not change those state machine rules or create another engine.
 *
 * This is a server-side composition, not a WhatsApp route.
 */
export async function prepareIncidentalEncounterForCapture(
  deps: {
    readonly authorize: IncidentalOutcomeAuthorization;
    readonly encounters: Pick<EncounterService, "get" | "observe" | "engage">;
  },
  input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly outcomeId: string;
  },
): Promise<Result<EncounterView>> {
  if (!(await deps.authorize.belongsToPlayer(input))) {
    return err(appError("FLOW_BLOCKED", "The incidental outcome is not active for this trainer"));
  }
  const current = await deps.encounters.get(input.playerId, input.encounterId);
  if (!current.ok) return current;
  let view = current.value;
  if (view.status === "CREATED") {
    const observed = await deps.encounters.observe({
      playerId: input.playerId,
      encounterId: input.encounterId,
      expectedRevision: view.revision,
    });
    if (!observed.ok) return observed;
    view = observed.value;
  }
  if (view.status === "PRESENTED") {
    const engaged = await deps.encounters.engage({
      playerId: input.playerId,
      encounterId: input.encounterId,
      expectedRevision: view.revision,
    });
    if (!engaged.ok) return engaged;
    view = engaged.value;
  }
  if (view.status !== "ENGAGED") {
    return err(appError("FLOW_BLOCKED", "Encounter is not available for one-tap capture"));
  }
  return ok(view);
}
