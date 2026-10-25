import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface ExpeditionRescueArea {
  readonly areaId: string;
  readonly active: boolean;
  /** Must come from active World content, not an authored draft. */
  readonly explorationApproved: boolean;
  readonly safePoint: boolean;
}

export interface ExpeditionRescueConnection {
  readonly fromAreaId: string;
  readonly toAreaId: string;
  /** Derived from published World adjacency and current access/unlocks. */
  readonly available: boolean;
}

export interface ExpeditionRescueTopology {
  readonly contentReleaseId: string;
  readonly areas: readonly ExpeditionRescueArea[];
  readonly connections: readonly ExpeditionRescueConnection[];
}

export interface ExpeditionBlackoutRescuePlan {
  readonly contentReleaseId: string;
  readonly fromAreaId: string;
  readonly safeAreaId: string;
  /** Verified contiguous directed route; includes origin and destination. */
  readonly routeAreaIds: readonly string[];
  readonly requiresRelocation: boolean;
}

function blocked(message: string): Result<never> {
  return err(
    appError("FLOW_BLOCKED", message, {
      userMessage: "O Rotom não encontrou um resgate seguro. Avise a equipe de suporte.",
    }),
  );
}

/**
 * V1.5 deterministic, side-effect-free rescue decision. Blackout NEVER
 * defaults to teleporting to the starter town. Resolve only from a trusted,
 * release-pinned, player-unlock-filtered World graph.
 *
 * The candidate is the reachable approved safe area with fewest directed
 * connections, breaking equal-distance ties by stable area identity.
 * Authoritative World relocation, healing and expedition termination MUST
 * still share an idempotent transaction, never run from this pure function.
 */
export function planExpeditionBlackoutRescue(input: {
  readonly expectedContentReleaseId: string;
  readonly currentAreaId: string;
  readonly topology: ExpeditionRescueTopology;
}): Result<ExpeditionBlackoutRescuePlan> {
  const { topology, currentAreaId, expectedContentReleaseId } = input;
  if (
    !expectedContentReleaseId ||
    topology.contentReleaseId !== expectedContentReleaseId ||
    !currentAreaId
  ) {
    return blocked("Blackout World release is not pinned to the current expedition");
  }

  const areaMap = new Map<string, ExpeditionRescueArea>();
  for (const area of topology.areas) {
    if (!area.areaId || areaMap.has(area.areaId)) {
      return blocked("Blackout World has invalid area identities");
    }
    areaMap.set(area.areaId, area);
  }
  const origin = areaMap.get(currentAreaId);
  if (!origin?.active || !origin.explorationApproved) {
    return blocked("Blackout origin is outside approved active World");
  }

  const graph = new Map<string, string[]>();
  for (const connection of topology.connections) {
    if (
      !connection.fromAreaId ||
      !connection.toAreaId ||
      !areaMap.has(connection.fromAreaId) ||
      !areaMap.has(connection.toAreaId)
    ) {
      return blocked("Blackout graph contains a noncanonical connection");
    }
    const target = areaMap.get(connection.toAreaId);
    if (
      !connection.available ||
      !target?.active ||
      !target.explorationApproved ||
      connection.fromAreaId === connection.toAreaId
    ) {
      continue;
    }
    const source = areaMap.get(connection.fromAreaId);
    if (!source?.active || !source.explorationApproved) continue;
    const neighbors = graph.get(connection.fromAreaId) ?? [];
    if (!neighbors.includes(connection.toAreaId)) neighbors.push(connection.toAreaId);
    graph.set(connection.fromAreaId, neighbors);
  }
  for (const neighbors of graph.values()) neighbors.sort();

  const queue: string[][] = [[currentAreaId]];
  const visited = new Set([currentAreaId]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    const areaId = path?.at(-1);
    if (areaId === undefined) continue;
    const area = areaMap.get(areaId);
    if (area?.safePoint) {
      return ok({
        contentReleaseId: expectedContentReleaseId,
        fromAreaId: currentAreaId,
        safeAreaId: areaId,
        routeAreaIds: path,
        requiresRelocation: areaId !== currentAreaId,
      });
    }
    for (const next of graph.get(areaId) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return blocked("Blackout has no safely reachable recovery location");
}
