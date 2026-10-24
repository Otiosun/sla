import type { WorldLocationView } from "../world/contracts.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

/**
 * V1.1 launch scope. Other authored Zhoulia areas are not automatically open
 * for individual exploration merely because they exist in the world catalog.
 */
const LAUNCH_AREA_SLUGS = new Set(["vila-dos-arrozais", "campos-de-yun"]);

/**
 * Must be resolved by a trusted caller from the *published and active*
 * encounter tables of this exact content release, not the Zhoulia draft
 * catalog. No provider is wired until that database check exists.
 */
export interface PublishedExplorationAreas {
  readonly contentReleaseId: string;
  readonly encounterReadyAreaIds: readonly string[];
}

export interface ExplorationDestination {
  readonly areaId: string;
  readonly areaSlug: string;
  readonly displayName: string;
  readonly connectionId: string;
}

/**
 * Read-only preparation result. No travel cost is inferred, no world location
 * is changed, and no weekly quota or expedition clock is consumed here.
 */
export interface ExplorationWorldAdmission {
  readonly playerId: WorldLocationView["playerId"];
  readonly contentReleaseId: string;
  readonly currentAreaId: string;
  readonly currentAreaSlug: string;
  readonly availableDestinations: readonly ExplorationDestination[];
}

function blocked(message: string, userMessage: string): Result<never> {
  return err(appError("FLOW_BLOCKED", message, { userMessage }));
}

/**
 * Filters the canonical WorldService location view against the actual,
 * release-pinned encounter coverage. This is a read-only UI preflight,
 * NOT the transactional authorization to debit an expedition's first action.
 *
 * The eventual write path must recheck the same facts under the shared
 * player/location locks, in one transaction with world/action effects,
 * expedition clock/quota and the idempotency receipt.
 */
export function inspectExplorationWorld(input: {
  readonly playerId: WorldLocationView["playerId"];
  readonly location: WorldLocationView;
  readonly publishedAreas: PublishedExplorationAreas | null;
}): Result<ExplorationWorldAdmission> {
  const { playerId, location, publishedAreas } = input;

  if (location.playerId !== playerId) {
    return blocked(
      "World location belongs to another trainer",
      "Não foi possível confirmar sua localização. Consulte a RotomDex.",
    );
  }

  if (
    publishedAreas === null ||
    !publishedAreas.contentReleaseId ||
    publishedAreas.contentReleaseId !== location.contentReleaseId
  ) {
    return blocked(
      "Expedition encounter coverage is not verified for this content release",
      "A exploração ainda não está disponível nesta versão do mundo.",
    );
  }

  if (location.requiresRelocation) {
    return blocked(
      "Current world area is inactive",
      "Sua localização precisa ser regularizada antes de explorar.",
    );
  }

  if (location.regionSlug !== "zhoulia" || !LAUNCH_AREA_SLUGS.has(location.areaSlug)) {
    return blocked(
      "Area is outside the initial individual-exploration scope",
      "Esta área ainda não foi liberada para exploração individual.",
    );
  }

  const encounterReadyAreas = new Set(publishedAreas.encounterReadyAreaIds);
  if (!encounterReadyAreas.has(location.areaId)) {
    return blocked(
      "Current area has no verified active encounter coverage",
      "Ainda não há encontros liberados para exploração nesta área.",
    );
  }

  const availableDestinations: ExplorationDestination[] = location.connections
    .filter(
      (connection) =>
        connection.available &&
        connection.missingUnlockKeys.length === 0 &&
        LAUNCH_AREA_SLUGS.has(connection.destinationSlug) &&
        connection.destinationAreaId !== location.areaId &&
        encounterReadyAreas.has(connection.destinationAreaId),
    )
    .map((connection) => ({
      areaId: connection.destinationAreaId,
      areaSlug: connection.destinationSlug,
      displayName: connection.destinationDisplayName,
      connectionId: connection.connectionId,
    }));

  return ok({
    playerId,
    contentReleaseId: location.contentReleaseId,
    currentAreaId: location.areaId,
    currentAreaSlug: location.areaSlug,
    availableDestinations,
  });
}
