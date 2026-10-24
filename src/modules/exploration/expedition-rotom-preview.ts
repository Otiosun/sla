import type { Clock } from "../../platform/clock/index.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { WorldService } from "../world/service.js";
import {
  inspectExplorationWorld,
  type PublishedExplorationAreas,
} from "./expedition-world-admission.js";
import {
  expeditionClock,
  type ExpeditionClockView,
  EXPEDITION_WEEKLY_LIMIT,
} from "./expedition-clock.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";
import { expeditionWeekKey, expeditionWeeklyAdmission } from "./expedition-week.js";

interface PreviewFacts {
  readonly expedition: ExpeditionSnapshot | null;
  readonly usedThisWeek: number;
}

export interface ExplorationRotomPreview {
  readonly locationName: string;
  readonly contentReleaseId: string;
  readonly phase: "NONE" | "PREPARING" | "ACTIVE";
  readonly originMatchesCurrent: boolean | null;
  readonly clock: ExpeditionClockView | null;
  readonly usedThisWeek: number;
  readonly remainingThisWeek: number;
  readonly canPrepareUnderPolicy: boolean;
  readonly canContinueUnderPolicy: boolean;
  readonly destinations: readonly string[];
  /** This preview never enables a command or spends a resource. */
  readonly actionsEnabled: false;
}

/**
 * Read-only composition of World published coverage and V1.1 expedition facts.
 * No WhatsApp registration, no user actions, and no transactional authorization
 * for any later write. Every mutating action must recheck all of its gates.
 */
export class ExpeditionRotomPreviewService {
  public constructor(
    private readonly world: Pick<WorldService, "getLocation">,
    private readonly published: {
      forActiveRelease(releaseId: string): Promise<PublishedExplorationAreas | null>;
    },
    private readonly facts: {
      read(playerId: PlayerId, weekKey: string): Promise<PreviewFacts>;
    },
    private readonly clockSource: Clock,
    private readonly timeZone: string,
  ) {
    expeditionWeekKey(clockSource.now(), timeZone);
  }

  public async inspect(playerId: PlayerId): Promise<Result<ExplorationRotomPreview>> {
    const location = await this.world.getLocation(playerId);
    if (!location.ok) return location;
    const content = await this.published.forActiveRelease(location.value.contentReleaseId);
    const admission = inspectExplorationWorld({
      playerId,
      location: location.value,
      publishedAreas: content,
    });
    if (!admission.ok) return admission;

    const weekKey = expeditionWeekKey(this.clockSource.now(), this.timeZone);
    const facts = await this.facts.read(playerId, weekKey);
    const expedition = facts.expedition;
    if (
      !Number.isSafeInteger(facts.usedThisWeek) ||
      facts.usedThisWeek < 0 ||
      facts.usedThisWeek > EXPEDITION_WEEKLY_LIMIT
    ) {
      return err(appError("FLOW_BLOCKED", "Expedition weekly data is inconsistent"));
    }
    if (
      expedition !== null &&
      (expedition.playerId !== playerId ||
        expedition.phase === "ENDED" ||
        expedition.currentAreaId !== location.value.areaId)
    ) {
      return err(
        appError("FLOW_BLOCKED", "Expedition state disagrees with canonical World location"),
      );
    }

    const phase = expedition?.phase ?? "NONE";
    const weekly = expeditionWeeklyAdmission(facts.usedThisWeek, phase);
    return ok({
      locationName: location.value.areaDisplayName,
      contentReleaseId: location.value.contentReleaseId,
      phase,
      originMatchesCurrent:
        expedition === null ? null : expedition.areaId === location.value.areaId,
      clock:
        expedition === null ? null : expeditionClock(expedition.period, expedition.elapsedMinutes),
      usedThisWeek: facts.usedThisWeek,
      remainingThisWeek: weekly.remaining,
      canPrepareUnderPolicy: weekly.canPrepare,
      canContinueUnderPolicy: weekly.canContinue,
      destinations: admission.value.availableDestinations.map(
        (destination) => destination.displayName,
      ),
      actionsEnabled: false,
    });
  }
}
