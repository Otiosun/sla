import { createHash } from "node:crypto";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import { appError, err, ok } from "../../shared-kernel/result.js";
import { WorldService } from "../../modules/world/service.js";
import type { Clock } from "../clock/index.js";
import { worldRepositoryForClient } from "../world/postgres-world-repository.js";
import type { FirstActionEffect } from "./postgres-expedition-first-action.js";
import { publishedExplorationAreasInTransaction } from "./postgres-published-exploration-areas.js";

export interface CanonicalTravelEffectInput {
  readonly destinationAreaId: string;
  readonly expectedLocationRevision: bigint;
  readonly worldFeature: FeatureAvailability;
  readonly clock: Clock;
}

/**
 * A World travel effect for the V1.1 first-action transaction, NOT a runtime
 * route or a new movement engine. WorldService controls adjacency, unlocks,
 * destination status, travel locks, visits and its own idempotency receipt.
 *
 * The expedition action's elapsed minutes MUST be separately sourced from a
 * reviewed route-time policy. World travelSeconds are real-time cooldowns and
 * cannot be reused as expedition minutes.
 */
export function canonicalWorldTravelEffect(input: CanonicalTravelEffectInput): FirstActionEffect {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "EXPEDITION_CANONICAL_WORLD_TRAVEL_V1",
        input.destinationAreaId,
        input.expectedLocationRevision.toString(),
      ]),
    )
    .digest("hex");

  return {
    actionKey: "world.travel",
    actionFingerprint: digest,
    async apply(client, context) {
      if (input.destinationAreaId === context.areaId) {
        return err(appError("ACTION_INVALID", "Travel destination equals the current area"));
      }
      // WorldService itself validates adjacency and unlocks. Additionally,
      // the expedition's V1.1 launch must not travel into unpublished areas.
      const published = await publishedExplorationAreasInTransaction(
        client,
        context.contentReleaseId,
      );
      if (
        published === null ||
        !published.encounterReadyAreaIds.includes(input.destinationAreaId)
      ) {
        return err(appError("FLOW_BLOCKED", "Destination is outside published exploration areas"));
      }

      // The published connection owns expedition minutes. Never treat the
      // World real-time travelSeconds cooldown as in-game clock minutes.
      const repository = worldRepositoryForClient(client);
      const connection = await repository.read((tx) =>
        tx.connectionBetween(context.contentReleaseId, context.areaId, input.destinationAreaId),
      );
      const approvedMinutes = connection?.active
        ? connection.accessRule.explorationMinutes
        : undefined;
      if (approvedMinutes === undefined) {
        return err(
          appError("FLOW_BLOCKED", "Published World connection has no expedition travel duration"),
        );
      }
      if (context.minutes !== approvedMinutes) {
        return err(
          appError("ACTION_INVALID", "Expedition clock charge must match published route duration"),
        );
      }

      // Reuse the entire canonical World mutation inside the OUTER SQL tx.
      const world = new WorldService(repository, input.worldFeature, input.clock);
      const result = await world.travel({
        playerId: context.playerId,
        destinationAreaId: input.destinationAreaId,
        expectedRevision: input.expectedLocationRevision,
        idempotencyKey: context.idempotencyKey,
      });
      if (!result.ok) return result;
      if (
        result.value.from.areaId !== context.areaId ||
        result.value.to.areaId !== input.destinationAreaId ||
        result.value.to.contentReleaseId !== context.contentReleaseId
      ) {
        return err(appError("FLOW_BLOCKED", "World travel returned an inconsistent location"));
      }

      // Narrow to a JSON-stable receipt payload: World views carry bigint
      // revisions and Date values which cannot be directly JSON-serialized.
      return ok({
        kind: "WORLD_TRAVEL" as const,
        contentReleaseId: context.contentReleaseId,
        fromAreaId: result.value.from.areaId,
        toAreaId: result.value.to.areaId,
        toAreaSlug: result.value.to.areaSlug,
        worldRevision: result.value.to.revision.toString(),
        expeditionMinutes: approvedMinutes,
        firstVisit: result.value.arrival?.firstVisit ?? false,
      });
    },
  };
}
