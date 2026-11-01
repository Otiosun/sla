import type { EncounterService } from "../encounter/service.js";
import { parseEncounterId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  ExpeditionSearchSentProofInput,
  DeliveredExpeditionEncounter,
  PostgresExpeditionSearchSentProof,
} from "../../platform/exploration/postgres-expedition-search-sent-proof.js";

/**
 * Isolated staging seam AFTER successful Outbox delivery. No player command,
 * no publicly registered handler, no BattleService or CaptureService.
 *
 * The original encounter is the ONLY mutation target. We never create, reroll
 * or grant a Pokémon. Transition only through the canonical EncounterService.
 * A separate idempotent menu issuance + quoted-message binding is still
 * required before permitting any battle/capture actions.
 */
export class ExpeditionSearchEngagementAfterSent {
  public constructor(
    private readonly proof: Pick<PostgresExpeditionSearchSentProof, "confirm">,
    private readonly encounters: Pick<EncounterService, "observe" | "engage">,
  ) {}

  public async engageAfterSent(
    input: ExpeditionSearchSentProofInput,
  ): Promise<Result<DeliveredExpeditionEncounter>> {
    const verified = await this.proof.confirm(input);
    if (!verified.ok) return verified;
    const observed = verified.value;
    const id = parseEncounterId(observed.encounterId);
    if (!id.ok) return id;

    if (observed.encounterStatus === "ENGAGED") return ok(observed);
    let revision = observed.encounterRevision;
    if (observed.encounterStatus === "CREATED") {
      const presented = await this.encounters.observe({
        playerId: observed.playerId,
        encounterId: id.value,
        expectedRevision: revision,
      });
      if (!presented.ok) return presented;
      if (
        presented.value.playerId !== observed.playerId ||
        presented.value.encounterId !== observed.encounterId ||
        presented.value.areaId !== observed.areaId ||
        !["PRESENTED", "ENGAGED"].includes(presented.value.status)
      ) {
        return err(appError("FLOW_BLOCKED", "Encounter presentation diverged from SENT proof"));
      }
      if (presented.value.status === "ENGAGED") {
        return ok({
          ...observed,
          encounterStatus: "ENGAGED",
          encounterRevision: presented.value.revision,
        });
      }
      revision = presented.value.revision;
    }

    const engaged = await this.encounters.engage({
      playerId: observed.playerId,
      encounterId: id.value,
      expectedRevision: revision,
    });
    if (!engaged.ok) return engaged;
    if (
      engaged.value.status !== "ENGAGED" ||
      engaged.value.playerId !== observed.playerId ||
      engaged.value.encounterId !== observed.encounterId ||
      engaged.value.areaId !== observed.areaId
    ) {
      return err(appError("FLOW_BLOCKED", "Encounter engagement diverged from SENT proof"));
    }
    return ok({
      ...observed,
      encounterStatus: "ENGAGED",
      encounterRevision: engaged.value.revision,
    });
  }
}
